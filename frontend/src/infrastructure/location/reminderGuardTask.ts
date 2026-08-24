import * as Location from 'expo-location';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

import {
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
const TIMEFLOW_DATABASE_NAME = 'timeflow.db';
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

/** 懒加载，参照 geofenceTask.ts 同名函数：避免顶层 import 在测试环境直接抛错。 */
async function loadStorageModules(): Promise<{
  openDatabaseAsync: typeof import('expo-sqlite').openDatabaseAsync;
} | null> {
  try {
    const sqlite = await import('expo-sqlite');
    // istanbul ignore next -- unreachable in this Jest env: the import above always throws
    // first (no --experimental-vm-modules), so this line never runs.
    return { openDatabaseAsync: sqlite.openDatabaseAsync };
  } catch {
    return null;
  }
}

async function openDatabase(): Promise<SQLiteDatabase | null> {
  const modules = await loadStorageModules();
  if (modules == null) return null;
  try {
    // istanbul ignore next -- same as above, unreachable without a real expo-sqlite.
    return await modules.openDatabaseAsync(TIMEFLOW_DATABASE_NAME);
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

    if (sample == null) {
      console.warn('[guard] task woken with no location payload', payload);
    } else if (listeners.size === 0) {
      console.warn('[guard] no live listeners, taking headless location pass', sample);
      await runHeadlessLocationPass(sample);
    } else {
      console.warn('[guard] dispatching sample to', listeners.size, 'live listener(s)');
      for (const listener of listeners) {
        await listener(sample);
      }
    }

    // 时间型兜底 + 卡住扫描：跟"喂位置样本"是两件独立的事，不管这次唤醒有没有
    // 拿到有效定位、不管会话是否存活，每次唤醒都要做——这两件事全靠直接查
    // SQLite + 原生桥接，不依赖 LocalReminderApplication 的内存状态，headless
    // 上下文里也能跑。
    await runTimeFallbackPass();
    await runStuckPendingPass();
  });
}

/** 跟 SqliteLocalScheduleReader.ts 的 DEFAULT_GEOFENCE_RADIUS_METERS 保持一致——
 * 半径目前是应用级默认值，不是逐条日程可配的列，local_schedules 表里没有这一列。 */
const DEFAULT_GEOFENCE_RADIUS_METERS = 200;

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
async function runHeadlessLocationPass(sample: GuardTaskSample): Promise<void> {
  const database = await openDatabase();
  if (database == null) return;
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
      if (center == null) continue;

      const transition = evaluateGeofence(schedule, sample, mode);
      if (transition === 'armed') {
        await database.runAsync(
          `UPDATE local_schedules SET geofence_armed = 1 WHERE id = ? AND geofence_armed = 0`,
          row.id,
        );
        continue;
      }
      if (transition !== 'triggered') continue;

      // 先消耗边沿再送达，失败也不恢复 armed——跟 geofenceTask.ts 的既有约定一致。
      await database.runAsync(`UPDATE local_schedules SET geofence_armed = 0 WHERE id = ?`, row.id);
      await presentOrNotify(
        row.id,
        row.title || '日程提醒',
        row.reminder_strength ?? 'medium',
        row.reminder_type === 'return_to_recorded_location'
          ? `您已回到${row.location_name ?? '记录地点'}附近，请及时处理。`
          : `您已进入${row.location_name ?? '目标地点'}附近，请及时处理。`,
      );
      await database.runAsync(
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
 */
async function runTimeFallbackPass(): Promise<void> {
  const database = await openDatabase();
  if (database == null) return;
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
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const triggerAt = resolveEffectiveTriggerAt(toPartialTimeSchedule(row));
      if (triggerAt == null || Date.parse(nowIso) < Date.parse(triggerAt)) continue;

      const armed = await bridge.nativeHasArmedAlarm(row.id);
      if (armed) continue;

      await presentOrNotify(
        row.id,
        row.title || '日程提醒',
        row.reminder_strength ?? 'medium',
        null,
      );
      await database.runAsync(
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
async function runStuckPendingPass(): Promise<void> {
  const database = await openDatabase();
  if (database == null) return;
  // istanbul ignore next -- unreachable without a real expo-sqlite.
  {
    const rows = await database.getAllAsync<StuckPendingRow>(
      `SELECT id, title, reminder_strength, disposition_updated_at
         FROM local_schedules
        WHERE status = 'active'
          AND reminder_disposition_state = 'pending'`,
    );
    const nowMs = Date.now();
    for (const row of rows) {
      const updatedMs =
        row.disposition_updated_at == null ? null : Date.parse(row.disposition_updated_at);
      if (updatedMs == null || Number.isNaN(updatedMs)) continue;
      if (nowMs - updatedMs < STUCK_PENDING_THRESHOLD_MS) continue;
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
    if (presented) return;
  } catch {
    // 走下面的系统通知兜底。
  }

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
  let nearest = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const dLat = target.latitude - currentSample.latitude;
    const dLng = target.longitude - currentSample.longitude;
    // 粗略估算就够用（只用来决定轮询密度，不用来判定进出圈），省得为了选轮询
    // 间隔又跑一遍 Haversine——真正的进出圈判定始终走 evaluateGeofence()。
    const approxMeters = Math.sqrt(dLat * dLat + dLng * dLng) * 111_000;
    if (approxMeters < nearest) nearest = approxMeters;
  }
  return resolveGuardPollIntervalMs(nearest);
}
