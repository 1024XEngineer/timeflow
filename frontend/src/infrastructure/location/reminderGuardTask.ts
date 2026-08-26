import * as Location from 'expo-location';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';

import { withDatabaseAccess } from '../database/accessGate';
import {
  DEFAULT_GEOFENCE_RADIUS_METERS,
  distanceMeters,
  evaluateGeofence,
  resolveGeofenceCenter,
  resolveGuardPollIntervalMs,
  resolveWatchMode,
} from '../../features/reminder/domain/geofence';
import { resolveStrengthDeliveryPlan } from '../../features/reminder/domain/strengthDelivery';
import { resolveEffectiveTriggerAt } from '../../features/reminder/domain/timeWindow';
import type {
  GeoPoint,
  LocalReminderSchedule,
  ReminderStrength,
} from '../../features/reminder/domain';
import {
  NOOP_CLIENT_TELEMETRY,
  boundAppState,
  type ClientTelemetryPort,
} from '../../shared/observability';

export const GUARD_TASK_NAME = 'timeflow-reminder-guard';
export const GUARD_NOTIFICATION_TITLE = 'Timeflow 提醒守护';
export const GUARD_NOTIFICATION_BODY = '提醒守护运行中';

/**
 * 这个任务的注册形态必须跟 App 的前后台状态严格对齐——expo-location 原生侧对
 * "带不带 foregroundService"有两条方向相反的硬约束，挑任何一个固定值都会踩坑：
 *
 * 1. App 不在前台时**带** foregroundService 注册 → LocationModule.kt 直接抛
 *    ForegroundServiceStartNotAllowedException。
 * 2. App 在前台、常驻服务正在跑时，用**不带** foregroundService 的同名注册重注册
 *    → LocationTaskConsumer.maybeStartForegroundService() 命中
 *    `if (mService != null && !useForegroundService) stopForegroundService()`，
 *    把常驻前台服务当场拆掉。
 *
 * 注意 2 的对偶：App 在后台时那个方法在更前面就 early return 了（"Foreground
 * location task cannot be started while the app is in the background!"），走不到
 * 拆除分支——也就是说后台不带 foregroundService 是安全的，前台不带才是致命的。
 *
 * 真机实测过的故障链（守护通知出现约 1.2 秒后消失、之后重启都起不来）：
 * ReminderGuardCoordinator 带 foregroundService 建起服务 → 任务第一次唤醒 →
 * 末尾 refreshGuardRegistration() 不带 foregroundService 重注册 → 命中约束 2 →
 * 服务被拆。而 hasStartedLocationUpdatesAsync() 分辨不出这种"注册还在、服务没了"
 * 的降级态，协调器就此永远早退；这份降级注册还会被 expo-task-manager 持久化，
 * force-stop / 冷启动都清不掉，只有热重载（真的 unregister 一次）才碰巧修好。
 */
export function isAppForegrounded(): boolean {
  return AppState.currentState === 'active';
}
/** 卡在 pending 超过这么久还没被确认/延后，当成"响了但没送达"重新弹一次。 */
const STUCK_PENDING_THRESHOLD_MS = 2 * 60_000;

export type GuardTaskSample = {
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  observed_at: string;
};

type GuardTaskListener = (sample: GuardTaskSample) => unknown;

/**
 * 单槽，不是集合——这个任务只该有一个消费者（ReminderGuardCoordinator），而
 * AppRoot 的 `useMemo(() => createAppServices())` 会在 Fast Refresh 时重建整个服务
 * 容器、不销毁旧实例。用 Set 的话订阅者只增不减：真机上量到过订阅者涨到 3 个、
 * 同一个事件被处理三遍，也量到过槽位被清空后长时间没人补上（连续 8 个 tick 为空）。
 */
let taskListener: GuardTaskListener | null = null;
let guardTelemetry: ClientTelemetryPort = NOOP_CLIENT_TELEMETRY;

/** 组合根注入埋点；headless 唤醒时也能上报后台是否真的弹出了提醒。 */
export function setGuardTaskTelemetry(telemetry: ClientTelemetryPort): void {
  guardTelemetry = telemetry;
}

/** 订阅常驻前台服务的位置心跳；须在应用入口尽早 import 本模块以完成 defineTask。 */
export function subscribeGuardTaskEvents(listener: GuardTaskListener): () => void {
  taskListener = listener;
  // 只有还占着槽位的那个 listener 才能把槽位清空——不加这个判断的话，一个早已
  // 被顶掉的旧实例调用自己的退订函数时，会把现役 listener 一起清掉。
  return () => {
    if (taskListener === listener) taskListener = null;
  };
}

/**
 * 拿全应用共用的那一条连接，不自己 openDatabaseAsync——重复打开同一个库会让
 * 原生对象被提前释放、把主会话那条连接一起弄废（详见 infrastructure/database/
 * sqlite.ts 的说明）。懒加载是为了避免顶层 import 在测试环境直接抛错，参照
 * 这个仓库里原生相关的按需依赖一律走动态 import 的既有约定。
 */
async function openDatabase(): Promise<SQLiteDatabase | null> {
  try {
    const { openTimeflowDatabase } = await import('../database/sqlite');
    // istanbul ignore next -- unreachable in this Jest env: the import above always
    // throws first (expo-sqlite has no ESM build under Jest), so this never runs.
    return await openTimeflowDatabase();
  } catch {
    return null;
  }
}

if (!TaskManager.isTaskDefined(GUARD_TASK_NAME)) {
  TaskManager.defineTask(GUARD_TASK_NAME, async ({ data, error }) => {
    if (error) {
      console.warn('[guard] task reported error', error);
      return;
    }

    const payload = data as { locations?: Location.LocationObject[] } | undefined;
    const location = payload?.locations?.[payload.locations.length - 1];
    const sample: GuardTaskSample | null =
      location == null
        ? null
        : {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy_meters: location.coords.accuracy ?? 0,
            observed_at: new Date(location.timestamp).toISOString(),
          };

    // headless 直查全靠这个账号 id 限定范围——local_schedules 是全应用共用的一张表，
    // 登出不会删旧账号的行（只有单条删除日程那一条 DELETE），账号 A 登出、账号 B
    // 登录后 A 的数据原样留在库里。前台路径（SqliteLocalScheduleReader ->
    // scheduleLocalRepository）每次查询都显式传 accountId，这里也必须一样，不然
    // 会把上一个登出账号的地点/时间/pending 提醒当成当前账号的处理、展示、改状态。
    const accountId = await currentAccountId();

    // 数据库工作要跟主会话的读写排同一条队列（共用同一条物理连接，事务的
    // BEGIN/COMMIT 对所有调用方可见），但**不能**把 listener 分发也圈进队列：
    // listener 会一路走进 LocalReminderApplication，那边的仓储调用自己要排队，
    // 圈进来就是等这个任务自己持有的锁，直接死锁。所以下面按"是否碰数据库"
    // 分段，只把真正碰数据库的部分放进 withDatabaseAccess。
    //
    // 拿到的连接是全应用共用的那一条，用完不关：关掉会把 isClosed 置为 true，
    // 主会话那条持有同一个对象的连接会跟着一起失效。
    if (sample == null) {
      console.warn('[guard] task woken with no location payload', payload);
    } else if (taskListener != null) {
      console.warn('[guard] dispatching sample to the live listener');
      await taskListener(sample);
    } else if (isAppForegrounded()) {
      // 槽位空**不等于**会话已死，这是下面那条 headless 通道原来的判定错误所在。
      // 真机上实测：App 开在前台、界面正常渲染，槽位却连续 8 个 tick 是空的
      // （旧 coordinator 已退订、新的还没 start 到位的窗口期）。这时候如果照旧走
      // headless 地点判定，就会绕过 LocalReminderApplication 的内存锁去认领并弹
      // 提醒——那条通道的全部设计前提是"App 真的被系统杀了"，判错的代价正是这个
      // 仓库反复出现的"同一条提醒弹好几遍"。
      //
      // 所以前台时宁可地点判定这一跳什么都不做：漏一次轮询只是晚 30 秒，重复弹是
      // 用户直接可见的故障。真正的结构性修法是让数据库的认领成为唯一权威（弹之前
      // 先落 pending），那样这个 gate 退化成纯性能优化、判错也无害——但那要动
      // 提醒引擎，不在这次改动范围内。
      console.warn('[guard] no listener but app is foregrounded, skipping headless location pass');
    } else if (accountId == null) {
      console.warn('[guard] no persisted account session, skipping headless location pass');
    } else {
      // istanbul ignore next -- accountId 恒为 null（currentAccountId() 的动态 import
      // 在 Jest 里恒抛错，见上），这整个分支在单测里不可达。
      console.warn(
        '[guard] no live listener and app backgrounded, taking headless location pass',
        sample,
      );
      // istanbul ignore next -- 同上，accountId 恒为 null 时这个分支不可达。
      await withDatabaseAccess(async () => {
        const database = await openDatabase();
        if (database == null) return;
        await runHeadlessLocationPass(database, sample, accountId);
      });
    }

    // 时间型兜底 + 卡住扫描：跟上面的地点判定完全独立，只要 taskListener 是空的
    // （没有活着的会话在管）就该跑，不管这次唤醒有没有位置样本、App 在不在前台。
    // 这两个 pass 全靠"认领即权威"的条件 UPDATE 自保护（disposition_updated_at /
    // reminder_disposition_state 都带 WHERE 条件），跟 LocalReminderApplication
    // 自己的 JS 30s tick 并发执行最多互相抢一次 changes=0、不会脏写——不像上面的
    // 地点判定那样，判错前台/后台会直接导致重复弹窗，所以不需要对"前台但槽位空"
    // 的过渡态那么谨慎，一起跳过反而会让这段短暂的过渡期连时间型日程和卡住重弹
    // 都漏掉。真正需要避免重复的只有 taskListener != null 这一种情况：那意味着
    // 会话确实活着，JS tick 本来就在覆盖这两件事，硬跑只会增加一次无意义的抢锁。
    // istanbul ignore next -- accountId 恒为 null（同上），这个 if 整体在单测里不可达。
    if (taskListener == null && accountId != null) {
      await withDatabaseAccess(async () => {
        const database = await openDatabase();
        if (database == null) return;
        await runTimeFallbackPass(database, accountId);
        await runStuckPendingPass(database, accountId);
      });
    }

    // 常驻通知文案在这里刷新，不是被前台增删日程同步触发——见
    // ReminderGuardCoordinator.ensureLocationUpdates() 里的说明，那条路径只
    // 负责首次启动。这个任务本来就按插值间隔（15s~5min）自己醒，文案跟着
    // 这个节奏自然刷新：既能反映"这一刻还有没有需要处理的"，又不会跟前台
    // 操作抢着重新注册同一个任务。
    await withDatabaseAccess(async () => {
      const database = await openDatabase();
      if (database != null) await refreshGuardRegistration(database, sample, accountId);
    });
  });
}

/** headless 上下文读当前登录账号；没有持久化会话（从没登录过/已登出/token 过期）
 * 就代表没人在用这台设备，调用方据此整段跳过，不能不加限定地扫全表。 */
/* istanbul ignore next -- auth/data 的动态 import 在 Jest 里抛错，成功分支走不到。 */
async function currentAccountId(): Promise<string | null> {
  try {
    const { createAuthSessionStore } = await import('../../features/auth/data');
    const session = await createAuthSessionStore().read();
    return session?.accountId ?? null;
  } catch {
    return null;
  }
}

type HeadlessLocationRow = {
  id: string;
  title: string;
  latitude: number | null;
  longitude: number | null;
  reminder_type: string | null;
  reminder_strength: 'low' | 'medium' | 'high' | null;
  location_name: string | null;
  reminder_disposition_state: string | null;
  snoozed_until: string | null;
  geofence_armed: number;
};

/**
 * headless（没有存活会话）时的地点提醒判定：拿这次位置样本跟所有正在监听的
 * 地点提醒逐一比对，复用跟前台一致的 evaluateGeofence() 状态机，不是重新发明
 * 一套简化版判断逻辑。
 */
/* istanbul ignore next -- 需要真实 expo-sqlite（openDatabase() 恒为 null）才走得到。 */
async function runHeadlessLocationPass(
  database: SQLiteDatabase,
  sample: GuardTaskSample,
  accountId: string,
): Promise<void> {
  {
    const rows = await database.getAllAsync<HeadlessLocationRow>(
      `SELECT id, title, latitude, longitude, reminder_type,
              reminder_strength, location_name, reminder_disposition_state, snoozed_until,
              geofence_armed
         FROM local_schedules
        WHERE account_id = ?
          AND schedule_type = 'location'
          AND status = 'active'
          AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
      accountId,
    );

    for (const row of rows) {
      if (
        row.reminder_disposition_state === 'snoozed' &&
        row.snoozed_until != null &&
        Date.parse(row.snoozed_until) > Date.parse(sample.observed_at)
      ) {
        continue;
      }

      const schedule = toPartialLocationSchedule(row);
      const mode = resolveWatchMode(schedule);
      const center = resolveGeofenceCenter(schedule, mode);
      if (center == null) {
        console.warn(
          '[guard] location schedule has no resolvable center, skipping',
          row.id,
          row.title,
        );
        continue;
      }

      const transition = evaluateGeofence(schedule, sample, mode);
      if (transition === 'armed') {
        const armClaim = await database.runAsync(
          `UPDATE local_schedules SET geofence_armed = 1 WHERE id = ? AND geofence_armed = 0`,
          row.id,
        );
        console.warn('[guard] armed', row.id, 'changes=', armClaim.changes);
        continue;
      }
      if (transition !== 'triggered') {
        console.warn('[guard] no change for', row.id, '(neither armed nor triggered this tick)');
        continue;
      }
      console.warn('[guard] TRIGGERED, claiming and presenting', row.id, row.title);

      // 先消耗边沿再送达，失败也不恢复 armed：宁可漏一次，也不要因为送达失败就
      // 让下一个心跳再判定一次 triggered、重复弹同一条提醒。
      await database.runAsync(`UPDATE local_schedules SET geofence_armed = 0 WHERE id = ?`, row.id);

      // 先"认领"这一行再展示，不是反过来——这条查询和 LocalReminderApplication
      // 自己的送达逻辑可能同时在跑（比如 JS 30s 轮询也在处理同一条日程），
      // WHERE 里的条件让这次 UPDATE 在别人已经抢先落盘 pending 的情况下影响 0 行，
      // 用 changes 判断有没有真的抢到，抢不到就不弹，避免同一条提醒弹好几遍。
      const claim = await database.runAsync(
        `UPDATE local_schedules
         SET reminder_disposition_state = 'pending',
             next_trigger_at = NULL,
             disposition_updated_at = ?,
             sync_status = 'pending'
         WHERE id = ?
           AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
        sample.observed_at,
        row.id,
      );
      console.warn('[guard] claim result for', row.id, 'changes=', claim.changes);
      if (claim.changes === 0) continue;

      await presentOrNotify(
        row.id,
        row.title || '日程提醒',
        row.reminder_strength ?? 'medium',
        row.reminder_type === 'return_to_recorded_location'
          ? `您已回到${row.location_name ?? '记录地点'}附近，请及时处理。`
          : `您已进入${row.location_name ?? '目标地点'}附近，请及时处理。`,
        'location',
      );
    }
  }
}

function toPartialLocationSchedule(row: HeadlessLocationRow): LocalReminderSchedule {
  return {
    id: row.id,
    account_id: '',
    title: row.title,
    schedule_type: 'location',
    schedule_kind: 'once',
    is_all_day: false,
    start_time: null,
    end_time: null,
    timezone: 'UTC',
    recurrence_rule: null,
    location_name: row.location_name,
    latitude: row.latitude,
    longitude: row.longitude,
    geofence_radius_meters: DEFAULT_GEOFENCE_RADIUS_METERS,
    reminder: {
      reminder_type: (row.reminder_type ?? 'arrive_location') as never,
      reminder_trigger_at: null,
      reminder_offset_minutes: null,
      reminder_strength: row.reminder_strength ?? 'medium',
    },
    runtime: {
      reminder_disposition_state: null,
      next_trigger_at: null,
      snoozed_until: row.snoozed_until,
      geofence_armed: row.geofence_armed === 1,
      disposition_updated_at: null,
      sync_status: 'pending',
      // 跟 SqliteLocalScheduleReader.ts/SqliteReminderStateStore.ts 现状一致：
      // recorded_location 目前没有持久化到 local_schedules，读出来恒为 null——
      // return_to_recorded_location 模式在这条 headless 直查路径下暂时判不了，
      // resolveGeofenceCenter() 会因为拿不到中心点直接跳过，不是这次改动引入的新缺口。
      recorded_location: null,
    },
    status: 'active',
    revision: 0,
    cloud_revision: 0,
    updated_at: '',
  };
}

type HeadlessTimeRow = {
  id: string;
  title: string;
  schedule_kind: string;
  reminder_type: string | null;
  reminder_trigger_at: string | null;
  reminder_offset_minutes: number | null;
  reminder_strength: 'low' | 'medium' | 'high' | null;
  reminder_disposition_state: string | null;
  snoozed_until: string | null;
  next_trigger_at: string | null;
  start_time: string | null;
};

/**
 * 时间型兜底：原生闹钟当初没能挂上（比如精确闹钟权限缺失）的日程，靠这个
 * 常驻任务顶上——每次醒来看一遍有没有该展示但原生没接管的，直接 presentNow()。
 * "原生有没有接管"查的是 AlarmScheduler 持久化的挂钟列表（hasArmedAlarm），
 * 不是 JS 内存里的 registrations——这个任务可能跑在独立/headless 上下文，
 * 拿不到那份内存状态。
 *
 * hasArmedAlarm() 单独判定是不够的：AlarmSoundService 一响铃（onStartCommand）就
 * 会把这条闹钟从"已挂钟"列表里摘掉，不管全屏页/悬浮窗到底展示成功没有——也就是说
 * "响过、只是还没来得及告诉 JS"和"压根没挂上"这两种情况，在 hasArmedAlarm() 这一个
 * 信号上完全分不出来。原生还有另一份独立的、专门记录"已经响过"的缓冲区
 * （AlarmNativeBridge 的 SharedPreferences，peekNativeDispositions() 只读不清），
 * 会话存活时靠 hydrateNativeDispositions() 在冷启动读掉；这个 headless pass 之前
 * 完全不知道这份缓冲区的存在，会把"已经响过、还没同步"误判成"从没响过"再弹一次
 * ——是这个 pass 自己制造的重复触发，不是别处竞态传导过来的。加一次 peek 堵住。
 */
/* istanbul ignore next -- 需要真实 expo-sqlite 才走得到。 */
async function runTimeFallbackPass(database: SQLiteDatabase, accountId: string): Promise<void> {
  {
    const rows = await database.getAllAsync<HeadlessTimeRow>(
      `SELECT id, title, schedule_kind, reminder_type, reminder_trigger_at,
              reminder_offset_minutes, reminder_strength, reminder_disposition_state,
              snoozed_until, next_trigger_at, start_time
         FROM local_schedules
        WHERE account_id = ?
          AND schedule_type = 'time'
          AND status = 'active'
          AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
      accountId,
    );
    if (rows.length === 0) return;

    const bridge = await import('../notifications/native/TimeflowAlarmBridge');
    const alreadyFiredNatively = new Set(
      (await bridge.nativePeekAlarmDispositions()).map((record) => record.scheduleId),
    );
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const triggerAt = resolveEffectiveTriggerAt(toPartialTimeSchedule(row));
      if (triggerAt == null || Date.parse(nowIso) < Date.parse(triggerAt)) continue;

      const armed = await bridge.nativeHasArmedAlarm(row.id);
      if (armed) continue;
      // 原生缓冲区里已经有这条的记录：说明它响过了，只是还没同步到 SQLite——
      // 交给下次冷启动的 hydrateNativeDispositions() 去同步，这里不重新展示。
      if (alreadyFiredNatively.has(row.id)) continue;

      // 先"认领"再展示：这条日程同一时刻也可能正被 JS 30s 轮询处理（比如冷启动时
      // 一批过期日程同时该展示），谁先把这行的 disposition 从 null/snoozed 改成
      // pending，谁才有资格弹；changes === 0 说明已经被别的路径抢先处理了。
      const claim = await database.runAsync(
        `UPDATE local_schedules
         SET reminder_disposition_state = 'pending',
             next_trigger_at = NULL,
             disposition_updated_at = ?,
             sync_status = 'pending'
         WHERE id = ?
           AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
        nowIso,
        row.id,
      );
      if (claim.changes === 0) continue;

      await presentOrNotify(
        row.id,
        row.title || '日程提醒',
        row.reminder_strength ?? 'medium',
        null,
        'time',
      );
    }
  }
}

function toPartialTimeSchedule(row: HeadlessTimeRow): LocalReminderSchedule {
  return {
    id: row.id,
    account_id: '',
    title: row.title,
    schedule_type: 'time',
    schedule_kind: row.schedule_kind === 'recurring' ? 'recurring' : 'once',
    is_all_day: false,
    start_time: row.start_time,
    end_time: null,
    timezone: 'UTC',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 0,
    reminder: {
      reminder_type: (row.reminder_type ?? 'at_time') as never,
      reminder_trigger_at: row.reminder_trigger_at,
      reminder_offset_minutes: row.reminder_offset_minutes,
      reminder_strength: row.reminder_strength ?? 'medium',
    },
    runtime: {
      reminder_disposition_state: row.reminder_disposition_state === 'snoozed' ? 'snoozed' : null,
      next_trigger_at: row.next_trigger_at,
      snoozed_until: row.snoozed_until,
      geofence_armed: false,
      disposition_updated_at: null,
      sync_status: 'pending',
      recorded_location: null,
    },
    status: 'active',
    revision: 0,
    cloud_revision: 0,
    updated_at: '',
  };
}

type StuckPendingRow = {
  id: string;
  title: string;
  reminder_strength: 'low' | 'medium' | 'high' | null;
  disposition_updated_at: string | null;
};

/**
 * ③④⑤ 那类"原生响了、notifyFired 也到了，但用户一直没确认"的安全网：disposition
 * 一直卡在 pending 超过阈值，大概率是响铃页被 OEM 拦了或者被前一条挤进队列后
 * 没人记得回来处理——重新弹一次 presentNow()，给它一次补救机会。
 */
/* istanbul ignore next -- 需要真实 expo-sqlite 才走得到。 */
async function runStuckPendingPass(database: SQLiteDatabase, accountId: string): Promise<void> {
  {
    const rows = await database.getAllAsync<StuckPendingRow>(
      `SELECT id, title, reminder_strength, disposition_updated_at
         FROM local_schedules
        WHERE account_id = ?
          AND status = 'active'
          AND reminder_disposition_state = 'pending'`,
      accountId,
    );
    const now = new Date();
    const nowMs = now.getTime();
    for (const row of rows) {
      const updatedMs =
        row.disposition_updated_at == null ? null : Date.parse(row.disposition_updated_at);
      if (updatedMs == null || Number.isNaN(updatedMs)) continue;
      if (nowMs - updatedMs < STUCK_PENDING_THRESHOLD_MS) continue;

      // 先把 disposition_updated_at 摸新再展示：一是跟别的路径抢这一行（比如用户
      // 这一刻恰好正在点确认，WHERE 里的旧时间戳就对不上了，changes 为 0）；
      // 二是顺手把"卡住多久"这个计时器重置，不然每次醒来都按同一个旧时间戳
      // 判定超过阈值，会一直重复弹，而不是每隔一个阈值才弹一次。
      const claim = await database.runAsync(
        `UPDATE local_schedules
         SET disposition_updated_at = ?
         WHERE id = ?
           AND status = 'active'
           AND reminder_disposition_state = 'pending'
           AND disposition_updated_at = ?`,
        now.toISOString(),
        row.id,
        row.disposition_updated_at,
      );
      if (claim.changes === 0) continue;

      await presentOrNotify(
        row.id,
        row.title || '日程提醒',
        row.reminder_strength ?? 'medium',
        null,
        'time',
      );
    }
  }
}

/** 优先走原生全屏响铃页；presentNow 不可用/失败时退回普通系统通知。 */
async function presentOrNotify(
  scheduleId: string,
  title: string,
  strength: ReminderStrength,
  fallbackBody: string | null,
  scheduleType: 'time' | 'location',
): Promise<void> {
  const plan = resolveStrengthDeliveryPlan(strength);
  let presented = false;
  try {
    const bridge = await import('../notifications/native/TimeflowAlarmBridge');
    presented = await bridge.nativePresentAlarmNow(
      `guard-${scheduleId}-${Date.now()}`,
      scheduleId,
      title,
      plan.useVibration,
      plan.alarmSoundTier,
      true,
    );
    console.warn(
      '[guard] presentOrNotify: nativePresentAlarmNow returned',
      presented,
      'for',
      scheduleId,
    );
    if (presented) {
      recordGuardDelivery(true, scheduleType, strength);
      return;
    }
  } catch (error) {
    console.warn('[guard] presentOrNotify: nativePresentAlarmNow threw, falling back', error);
  }

  console.warn('[guard] presentOrNotify: falling back to expo-notifications for', scheduleId);
  try {
    const notifications = await import('expo-notifications');
    await notifications.setNotificationChannelAsync('timeflow-reminders', {
      name: '日程提醒',
      importance: notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180],
      lightColor: '#D7F36A',
      sound: 'default',
    });
    await notifications.scheduleNotificationAsync({
      identifier: `reminder-${scheduleId}`,
      content: {
        title,
        body: fallbackBody ?? '已到提醒时间，请及时处理。',
        sound: 'default',
        data: { schedule_id: scheduleId },
      },
      trigger: { channelId: 'timeflow-reminders' },
    });
    recordGuardDelivery(false, scheduleType, strength);
  } catch (error) {
    console.warn('[guard] presentOrNotify fallback notification failed', error);
  }
}

function recordGuardDelivery(
  presented: boolean,
  scheduleType: 'time' | 'location',
  strength: ReminderStrength,
): void {
  guardTelemetry.recordReminderDelivery({
    app_state: boundAppState(AppState.currentState),
    channel: presented ? 'native_full_screen' : 'system_notification',
    deferred_until_foreground: false,
    latency_bucket: 'unknown',
    manufacturer: 'other',
    native_armed: false,
    outcome: presented ? 'native_ok' : 'js_channel',
    overlay_failed: false,
    schedule_type: scheduleType,
    strength,
    trigger_source: 'headless_guard',
    used_fallback_audio: false,
  });
}

/** 只用来判断哪些行是地点型、算轮询密度——通知文案是固定文案，不需要标题/时间。 */
type GuardWatchRow = {
  id: string;
  schedule_type: 'time' | 'location';
  latitude: number | null;
  longitude: number | null;
};

/**
 * 每次唤醒都重新查一遍还有没有需要处理的日程，据此决定轮询间隔、一条不剩就
 * 自己把前台服务停掉，而不是留着继续空转耗电——这个判定跟
 * ReminderGuardCoordinator.reconcileInternal() 里 active.length === 0 时停止
 * 的逻辑保持一致。常驻通知文案是固定的"提醒守护运行中"，不做动态内容。
 */
/* istanbul ignore next -- 需要真实 expo-sqlite 才走得到。 */
async function refreshGuardRegistration(
  database: SQLiteDatabase,
  sample: GuardTaskSample | null,
  accountId: string | null,
): Promise<void> {
  {
    // 没有持久化的登录账号时不查——跟"0 条日程"一视同仁，直接走下面的自停分支；
    // 不能退化成不带 account_id 的全表扫描，否则会把已登出账号的数据当成当前
    // 账号还有日程要处理，一直不停这个前台服务。
    const rows =
      accountId == null
        ? []
        : await database.getAllAsync<GuardWatchRow>(
            `SELECT id, schedule_type, latitude, longitude
               FROM local_schedules
              WHERE account_id = ?
                AND status = 'active'
                AND (reminder_disposition_state IS NULL OR reminder_disposition_state != 'confirmed')`,
            accountId,
          );

    if (rows.length === 0) {
      try {
        const hasStarted = await Location.hasStartedLocationUpdatesAsync(GUARD_TASK_NAME);
        if (hasStarted) await Location.stopLocationUpdatesAsync(GUARD_TASK_NAME);
      } catch (error) {
        console.warn('[guard] self-stop on empty backlog failed', error);
      }
      return;
    }

    const targets: GeoPoint[] = rows
      .filter(
        (row): row is GuardWatchRow & { latitude: number; longitude: number } =>
          row.schedule_type === 'location' && row.latitude != null && row.longitude != null,
      )
      .map((row) => ({ latitude: row.latitude, longitude: row.longitude }));
    const currentSample: GeoPoint | null =
      sample == null ? null : { latitude: sample.latitude, longitude: sample.longitude };
    const intervalMs = resolveNextPollIntervalMs(currentSample, targets);

    // 这次调用发生在 GUARD_TASK_NAME 自己的 headless 回调里，App 在不在前台都有
    // 可能，所以 foregroundService 这个字段必须跟着当前前后台状态走，不能固定
    // 传或固定不传——两个方向的原生约束见 isAppForegrounded() 的注释。
    //
    // 上一版这里固定**不传**，理由是"headless 回调时大概率不在前台，传了会抛"。
    // 前半句没错，但漏了前台那一半：任务在前台唤醒时（冷启动后的第一次唤醒、
    // 用户正开着 App 的每一次唤醒）不传 foregroundService，原生会把它理解成
    // "不要常驻服务了"，直接把 ReminderGuardCoordinator 刚建起来的前台服务拆掉，
    // 而且拆掉之后再也建不回来。改成按前台状态选形态之后，两条路径都安全：
    // 前台带上 → 服务被保留/重建；后台不带 → 原生 early return，什么都不动。
    const foregroundService = isAppForegrounded()
      ? {
          notificationTitle: GUARD_NOTIFICATION_TITLE,
          notificationBody: GUARD_NOTIFICATION_BODY,
        }
      : undefined;

    try {
      await Location.startLocationUpdatesAsync(GUARD_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: intervalMs,
        distanceInterval: 0,
        ...(foregroundService == null ? {} : { foregroundService }),
      });
    } catch (error) {
      console.warn('[guard] refresh startLocationUpdatesAsync failed', error);
    }
  }
}

/**
 * 根据当前正在监听的地点提醒目标，算出下一次该用多密的轮询间隔重新注册。
 * 没有任何地点提醒时传 Infinity，落到最疏间隔——纯粹当时间型兜底的心跳用。
 */
export function resolveNextPollIntervalMs(
  currentSample: GeoPoint | null,
  targets: readonly GeoPoint[],
): number {
  if (currentSample == null || targets.length === 0) {
    return resolveGuardPollIntervalMs(Number.POSITIVE_INFINITY);
  }
  let nearestBoundary = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    // 用跟 evaluateGeofence() 同一个 distanceMeters()，不要自己按
    // 111km/度换算——纬度越高经度 1° 对应的实际距离越短，平面近似会在高纬度
    // 地区把距离算大，导致该加密轮询时没加密。
    const approxMeters = distanceMeters(currentSample, target);
    // resolveGuardPollIntervalMs 现在吃的是"离围栏边界还有多远"，不是离中心点
    // 多远——这里统一减掉半径，下界截到 0（已经在圈里时就是 0，自动进最密档）。
    const boundaryMeters = Math.max(0, approxMeters - DEFAULT_GEOFENCE_RADIUS_METERS);
    if (boundaryMeters < nearestBoundary) nearestBoundary = boundaryMeters;
  }
  return resolveGuardPollIntervalMs(nearestBoundary);
}
