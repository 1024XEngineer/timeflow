import * as Location from 'expo-location';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

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

export const GUARD_TASK_NAME = 'timeflow-reminder-guard';
export const GUARD_NOTIFICATION_TITLE = 'Timeflow 提醒守护';
/** 卡在 pending 超过这么久还没被确认/延后，当成"响了但没送达"重新弹一次。 */
const STUCK_PENDING_THRESHOLD_MS = 2 * 60_000;

export type GuardTaskSample = {
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  observed_at: string;
};

type GuardTaskListener = (sample: GuardTaskSample) => unknown;
const listeners = new Set<GuardTaskListener>();

/** 订阅常驻前台服务的位置心跳；须在应用入口尽早 import 本模块以完成 defineTask。 */
export function subscribeGuardTaskEvents(listener: GuardTaskListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 拿全应用共用的那一条连接，不自己 openDatabaseAsync——重复打开同一个库会让
 * 原生对象被提前释放、把主会话那条连接一起弄废（详见 infrastructure/database/
 * sqlite.ts 的说明）。懒加载是为了避免顶层 import 在测试环境直接抛错，参照
 * geofenceTask.ts 的同类做法。
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

    // 诊断用：每次唤醒都无条件打一行，不管走哪个分支——用来确认唤醒本身有没有
    // 发生、这一刻 listeners.size 到底是不是预期的那个值。定位问题排查完可以删。
    console.warn(
      '[guard] tick',
      'sample=',
      sample,
      'listeners.size=',
      listeners.size,
      'observed_at=',
      sample?.observed_at ?? null,
    );

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
    } else if (listeners.size > 0) {
      console.warn('[guard] dispatching sample to', listeners.size, 'live listener(s)');
      for (const listener of listeners) {
        await listener(sample);
      }
    } else {
      console.warn('[guard] no live listeners, taking headless location pass', sample);
      await withDatabaseAccess(async () => {
        const database = await openDatabase();
        if (database == null) return;
        await runHeadlessLocationPass(database, sample);

        // 时间型兜底 + 卡住扫描：只在会话没存活（App 真的被系统杀了，没有
        // LocalReminderApplication 在管）时才跑，所以就放在这个分支里。会话存活时
        // 这两件事完全没必要——JS 30s 轮询、原生闹钟已经够用——硬跑反而会跟
        // LocalReminderApplication 自己内存里的 activeDeliveries/deliverLocks 抢同一
        // 条日程：JS 那边已经在内存里认领、还没来得及写数据库的窗口期，这边从数据库
        // 看还是"没人认领"，两边各自独立弹一次，互不知道对方存在——这正是真机上
        // "同一条提醒弹好几遍、弹出来又被对方收尾逻辑关掉"的根源。
        await runTimeFallbackPass(database);
        await runStuckPendingPass(database);
      });
    }

    // 常驻通知文案在这里刷新，不是被前台增删日程同步触发——见
    // ReminderGuardCoordinator.ensureLocationUpdates() 里的说明，那条路径只
    // 负责首次启动。这个任务本来就按插值间隔（15s~5min）自己醒，文案跟着
    // 这个节奏自然刷新：既能反映"这一刻还有没有需要处理的"，又不会跟前台
    // 操作抢着重新注册同一个任务。
    await withDatabaseAccess(async () => {
      const database = await openDatabase();
      if (database != null) await refreshGuardRegistration(database, sample);
    });
  });
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
async function runHeadlessLocationPass(
  database: SQLiteDatabase,
  sample: GuardTaskSample,
): Promise<void> {
  // istanbul ignore next -- database only non-null with a real expo-sqlite, unreachable here.
  {
    const rows = await database.getAllAsync<HeadlessLocationRow>(
      `SELECT id, title, latitude, longitude, reminder_type,
              reminder_strength, location_name, reminder_disposition_state, snoozed_until,
              geofence_armed
         FROM local_schedules
        WHERE schedule_type = 'location'
          AND status = 'active'
          AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
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
      // 诊断用：把距离、原来的 armed 状态、这次判定结果都打出来——定位问题排查完
      // 可以删。距离是单独算的，跟 evaluateGeofence 内部用的是同一个 distanceMeters()。
      console.warn(
        '[guard] geofence eval',
        row.id,
        row.title,
        'distance=',
        Math.round(distanceMeters(sample, center)),
        'radius=',
        DEFAULT_GEOFENCE_RADIUS_METERS,
        'was_armed=',
        row.geofence_armed === 1,
        'transition=',
        transition,
      );
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

      // 先消耗边沿再送达，失败也不恢复 armed——跟 geofenceTask.ts 的既有约定一致。
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
async function runTimeFallbackPass(database: SQLiteDatabase): Promise<void> {
  // istanbul ignore next -- unreachable without a real expo-sqlite.
  {
    const rows = await database.getAllAsync<HeadlessTimeRow>(
      `SELECT id, title, schedule_kind, reminder_type, reminder_trigger_at,
              reminder_offset_minutes, reminder_strength, reminder_disposition_state,
              snoozed_until, next_trigger_at, start_time
         FROM local_schedules
        WHERE schedule_type = 'time'
          AND status = 'active'
          AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
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
async function runStuckPendingPass(database: SQLiteDatabase): Promise<void> {
  // istanbul ignore next -- unreachable without a real expo-sqlite.
  {
    const rows = await database.getAllAsync<StuckPendingRow>(
      `SELECT id, title, reminder_strength, disposition_updated_at
         FROM local_schedules
        WHERE status = 'active'
          AND reminder_disposition_state = 'pending'`,
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
): Promise<void> {
  const plan = resolveStrengthDeliveryPlan(strength);
  try {
    const bridge = await import('../notifications/native/TimeflowAlarmBridge');
    const presented = await bridge.nativePresentAlarmNow(
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
    if (presented) return;
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
  } catch (error) {
    console.warn('[guard] presentOrNotify fallback notification failed', error);
  }
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
async function refreshGuardRegistration(
  database: SQLiteDatabase,
  sample: GuardTaskSample | null,
): Promise<void> {
  // istanbul ignore next -- unreachable without a real expo-sqlite.
  {
    const rows = await database.getAllAsync<GuardWatchRow>(
      `SELECT id, schedule_type, latitude, longitude
         FROM local_schedules
        WHERE status = 'active'
          AND (reminder_disposition_state IS NULL OR reminder_disposition_state != 'confirmed')`,
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

    try {
      await Location.startLocationUpdatesAsync(GUARD_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: intervalMs,
        distanceInterval: 0,
        foregroundService: {
          notificationTitle: GUARD_NOTIFICATION_TITLE,
          notificationBody: '提醒守护运行中',
        },
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
    const dLat = target.latitude - currentSample.latitude;
    const dLng = target.longitude - currentSample.longitude;
    // 粗略估算就够用（只用来决定轮询密度，不用来判定进出圈），省得为了选轮询
    // 间隔又跑一遍 Haversine——真正的进出圈判定始终走 evaluateGeofence()。
    const approxMeters = Math.sqrt(dLat * dLat + dLng * dLng) * 111_000;
    // resolveGuardPollIntervalMs 现在吃的是"离围栏边界还有多远"，不是离中心点
    // 多远——这里统一减掉半径，下界截到 0（已经在圈里时就是 0，自动进最密档）。
    const boundaryMeters = Math.max(0, approxMeters - DEFAULT_GEOFENCE_RADIUS_METERS);
    if (boundaryMeters < nearestBoundary) nearestBoundary = boundaryMeters;
  }
  return resolveGuardPollIntervalMs(nearestBoundary);
}
