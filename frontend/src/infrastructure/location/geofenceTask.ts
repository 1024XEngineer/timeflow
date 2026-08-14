import * as Location from 'expo-location';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

export const GEOFENCE_TASK_NAME = 'timeflow-geofence';

export type GeofenceTaskPayload = {
  schedule_id: string;
  event: 'enter' | 'exit';
  latitude: number;
  longitude: number;
  radius: number;
  observed_at: string;
};

type GeofenceTaskListener = (payload: GeofenceTaskPayload) => void;

const listeners = new Set<GeofenceTaskListener>();

/** 没有订阅者时（App 进程已死，Expo 只把 JS 引擎拉起来跑这一个 headless task，
 * AppRoot/ExpoLocationMonitor 那套 React 生命周期根本没启动），通知失败的事件落这里，
 * 等真正的会话起来后由 drainPendingGeofenceEvents() 取走重放，而不是直接丢掉。 */
const PENDING_EVENTS_KEY = 'timeflow-pending-geofence-events';
const TIMEFLOW_DATABASE_NAME = 'timeflow.db';

type HeadlessScheduleRow = {
  id: string;
  title: string;
  location_name: string | null;
  schedule_type: string;
  reminder_type: string | null;
  reminder_disposition_state: string | null;
  snoozed_until: string | null;
  geofence_armed: number;
  status: string;
};

/** 订阅系统围栏任务回调；须在应用入口尽早 import 本模块以完成 defineTask。 */
export function subscribeGeofenceTaskEvents(listener: GeofenceTaskListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 懒加载：expo-sqlite/kv-store 的默认导出是模块加载时就构造的单例，顶层 import
 * 会在测试环境（没有真实原生模块）里直接抛错——这个仓库里原生相关的按需依赖
 * 一律走动态 import，参照 ExpoAudioPlayback.ts 的 loadExpoAudio()。 */
async function loadStorage(): Promise<typeof import('expo-sqlite/kv-store').Storage | null> {
  try {
    const mod = await import('expo-sqlite/kv-store');
    return mod.Storage;
  } catch {
    return null;
  }
}

/** 取出并清空 headless 期间攒下的围栏事件；调用方负责按订阅时的逻辑重放它们。 */
export async function drainPendingGeofenceEvents(): Promise<readonly GeofenceTaskPayload[]> {
  const storage = await loadStorage();
  if (storage == null) return [];
  const raw = await storage.getItem(PENDING_EVENTS_KEY);
  if (raw == null) return [];
  await storage.removeItem(PENDING_EVENTS_KEY);
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GeofenceTaskPayload[]) : [];
  } catch {
    return [];
  }
}

async function persistPendingEvent(payload: GeofenceTaskPayload): Promise<void> {
  const storage = await loadStorage();
  if (storage == null) return;
  const raw = await storage.getItem(PENDING_EVENTS_KEY);
  const pending: GeofenceTaskPayload[] = [];
  if (raw != null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) pending.push(...(parsed as GeofenceTaskPayload[]));
    } catch {
      // 上一份坏了就当没有，不阻塞这次事件的持久化。
    }
  }
  pending.push(payload);
  await storage.setItem(PENDING_EVENTS_KEY, JSON.stringify(pending));
}

async function emit(payload: GeofenceTaskPayload): Promise<void> {
  if (listeners.size === 0) {
    let delivered = false;
    try {
      delivered = await deliverHeadlessGeofenceEvent(payload);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      await persistPendingEvent(payload);
    }
    return;
  }
  for (const listener of listeners) {
    listener(payload);
  }
}

/**
 * Deliver a notification while Expo has only started this headless task.
 *
 * AppRoot/LocalReminderApplication is not alive in this path, so the task must keep
 * the same edge-triggered armed state in SQLite instead of notifying on every enter.
 * Returning false leaves the event in the existing pending queue for replay when the
 * normal application session starts.
 */
async function deliverHeadlessGeofenceEvent(payload: GeofenceTaskPayload): Promise<boolean> {
  const database = await openHeadlessDatabase();
  if (database == null) return false;

  if (payload.event === 'exit') {
    await database.runAsync(
      `UPDATE local_schedules
       SET geofence_armed = 1
       WHERE id = ?
         AND status = 'active'
         AND schedule_type = 'location'
         AND geofence_armed = 0`,
      payload.schedule_id,
    );
    return true;
  }

  const schedule = await database.getFirstAsync<HeadlessScheduleRow>(
    `SELECT id, title, location_name, schedule_type, reminder_type,
            reminder_disposition_state, snoozed_until, geofence_armed, status
       FROM local_schedules
      WHERE id = ?`,
    payload.schedule_id,
  );
  if (
    schedule == null ||
    schedule.status !== 'active' ||
    schedule.schedule_type !== 'location' ||
    schedule.geofence_armed !== 1 ||
    schedule.reminder_disposition_state === 'pending' ||
    schedule.reminder_disposition_state === 'confirmed' ||
    (schedule.reminder_disposition_state === 'snoozed' &&
      schedule.snoozed_until != null &&
      Date.parse(schedule.snoozed_until) > Date.parse(payload.observed_at))
  ) {
    return true;
  }

  const notifications = await loadNotifications();
  if (notifications == null) return false;
  await ensureAndroidChannel(notifications);
  notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  const notificationId = `reminder-${schedule.id}`;
  await notifications.scheduleNotificationAsync({
    identifier: notificationId,
    content: {
      title: schedule.title || '日程提醒',
      body:
        schedule.reminder_type === 'return_to_recorded_location'
          ? `您已回到${schedule.location_name ?? '记录地点'}附近，请及时处理。`
          : `您已进入${schedule.location_name ?? '目标地点'}附近，请及时处理。`,
      sound: 'default',
      data: { schedule_id: schedule.id, reason: schedule.reminder_type ?? 'arrive_location' },
    },
    trigger: null,
  });

  await database.runAsync(
    `UPDATE local_schedules
     SET geofence_armed = 0,
         reminder_disposition_state = 'pending',
         next_trigger_at = NULL,
         disposition_updated_at = ?,
         sync_status = 'pending'
     WHERE id = ?
       AND status = 'active'
       AND schedule_type = 'location'
       AND geofence_armed = 1
       AND (reminder_disposition_state IS NULL OR reminder_disposition_state = 'snoozed')`,
    payload.observed_at,
    schedule.id,
  );
  return true;
}

async function openHeadlessDatabase(): Promise<SQLiteDatabase | null> {
  try {
    const { openDatabaseAsync } = await import('expo-sqlite');
    return await openDatabaseAsync(TIMEFLOW_DATABASE_NAME);
  } catch {
    return null;
  }
}

async function loadNotifications(): Promise<typeof import('expo-notifications') | null> {
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

async function ensureAndroidChannel(
  notifications: typeof import('expo-notifications'),
): Promise<void> {
  await notifications.setNotificationChannelAsync('timeflow-reminders', {
    name: '日程提醒',
    importance: notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 180],
    lightColor: '#D7F36A',
  });
}

if (!TaskManager.isTaskDefined(GEOFENCE_TASK_NAME)) {
  TaskManager.defineTask(GEOFENCE_TASK_NAME, async ({ data, error }) => {
    if (error) return;

    const payload = data as
      | {
          eventType?: Location.GeofencingEventType;
          region?: Location.LocationRegion;
        }
      | undefined;
    const region = payload?.region;
    if (region?.identifier == null) return;

    const eventType = payload?.eventType;
    const event =
      eventType === Location.GeofencingEventType.Enter
        ? 'enter'
        : eventType === Location.GeofencingEventType.Exit
          ? 'exit'
          : null;
    if (event == null) return;

    await emit({
      schedule_id: region.identifier,
      event,
      latitude: region.latitude,
      longitude: region.longitude,
      radius: region.radius,
      observed_at: new Date().toISOString(),
    });
  });
}
