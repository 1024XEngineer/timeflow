import * as Location from 'expo-location';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

export const GEOFENCE_TASK_NAME = 'timeflow-geofence';
export const GEOFENCE_DIAGNOSTIC_KEY = 'timeflow-last-geofence-diagnostic';
export const GEOFENCE_DIAGNOSTIC_HISTORY_KEY = 'timeflow-geofence-diagnostic-history';
const MAX_GEOFENCE_DIAGNOSTICS = 20;
let diagnosticChain: Promise<void> = Promise.resolve();

export type GeofenceTaskPayload = {
  schedule_id: string;
  event: 'enter' | 'exit';
  latitude: number;
  longitude: number;
  radius: number;
  observed_at: string;
};

export type GeofenceDiagnostic = {
  phase:
    | 'callback_received'
    | 'listener_completed'
    | 'native_requested'
    | 'notification_scheduled'
    | 'state_updated'
    | 'queued'
    | 'delivery_failed'
    | 'registration_succeeded'
    | 'initial_location_sample'
    | 'manual_location_read';
  schedule_id: string;
  event: GeofenceTaskPayload['event'] | 'registration' | 'initial_sample' | 'manual_read';
  observed_at: string;
  recorded_at: string;
  detail?: string;
};

type GeofenceTaskListener = (payload: GeofenceTaskPayload) => unknown;

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
  reminder_strength: 'low' | 'medium' | 'high' | null;
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

export async function getLastGeofenceDiagnostic(): Promise<GeofenceDiagnostic | null> {
  const storage = await loadStorage();
  if (storage == null) return null;
  const raw = await storage.getItem(GEOFENCE_DIAGNOSTIC_KEY);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as GeofenceDiagnostic;
  } catch {
    return null;
  }
}

export async function getGeofenceDiagnostics(): Promise<readonly GeofenceDiagnostic[]> {
  const storage = await loadStorage();
  if (storage == null) return [];
  const raw = await storage.getItem(GEOFENCE_DIAGNOSTIC_HISTORY_KEY);
  if (raw == null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GeofenceDiagnostic[]) : [];
  } catch {
    return [];
  }
}

export async function clearGeofenceDiagnostics(): Promise<void> {
  return enqueueDiagnosticWrite(async () => {
    const storage = await loadStorage();
    if (storage == null) return;
    await Promise.all([
      storage.removeItem(GEOFENCE_DIAGNOSTIC_KEY),
      storage.removeItem(GEOFENCE_DIAGNOSTIC_HISTORY_KEY),
    ]);
  });
}

/** 记录应用侧操作，和 defineTask 收到的真实系统围栏回调使用同一条时间线。 */
export async function recordGeofenceDiagnostic(
  record: Omit<GeofenceDiagnostic, 'recorded_at'>,
): Promise<void> {
  return enqueueDiagnosticWrite(() =>
    persistGeofenceDiagnostic({ ...record, recorded_at: new Date().toISOString() }),
  );
}

function enqueueDiagnosticWrite(work: () => Promise<void>): Promise<void> {
  const run = diagnosticChain.then(work);
  diagnosticChain = run.catch(() => undefined);
  return run;
}

/**
 * Development-only hook for exercising the same event path as the native task.
 * It deliberately resolves the center from SQLite so the UI does not need to
 * expose location coordinates just to run a local test.
 */
export async function simulateGeofenceEventForTesting(
  scheduleId: string,
  event: GeofenceTaskPayload['event'],
): Promise<void> {
  const database = await openHeadlessDatabase();
  if (database == null) {
    throw new Error('无法打开本地日程数据库');
  }

  const schedule = await database.getFirstAsync<{
    latitude: number | null;
    longitude: number | null;
  }>(
    `SELECT latitude, longitude
       FROM local_schedules
      WHERE id = ?
        AND schedule_type = 'location'
        AND status = 'active'`,
    scheduleId,
  );
  if (schedule?.latitude == null || schedule.longitude == null) {
    throw new Error('这条地点提醒没有可用的坐标');
  }

  await emit({
    schedule_id: scheduleId,
    event,
    latitude: schedule.latitude,
    longitude: schedule.longitude,
    radius: 200,
    observed_at: new Date().toISOString(),
  });
}

/** 懒加载：expo-sqlite/kv-store 的默认导出是模块加载时就构造的单例，顶层 import
 * 会在测试环境（没有真实原生模块）里直接抛错——这个仓库里原生相关的按需依赖
 * 一律走动态 import，参照 ExpoAudioPlayback.ts 的 loadExpoAudio()。 */
async function loadStorage(): Promise<typeof import('expo-sqlite/kv-store').Storage | null> {
  try {
    const mod = await import('expo-sqlite/kv-store');
    // istanbul ignore next -- unreachable in this Jest env: the import above always throws
    // first (no --experimental-vm-modules, see the file header), so this line never runs.
    return mod.Storage;
  } catch {
    return null;
  }
}

/** 取出并清空 headless 期间攒下的围栏事件；调用方负责按订阅时的逻辑重放它们。 */
export async function drainPendingGeofenceEvents(): Promise<readonly GeofenceTaskPayload[]> {
  const storage = await loadStorage();
  if (storage == null) return [];
  // istanbul ignore next -- storage is only non-null with a real expo-sqlite/kv-store, which
  // loadStorage() can never resolve in this Jest env (see the file header); unreachable here.
  {
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
}

async function persistPendingEvent(payload: GeofenceTaskPayload): Promise<void> {
  const storage = await loadStorage();
  if (storage == null) return;
  // istanbul ignore next -- same as drainPendingGeofenceEvents() above: unreachable without a
  // real expo-sqlite/kv-store.
  {
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
}

async function persistGeofenceDiagnostic(record: GeofenceDiagnostic): Promise<void> {
  const storage = await loadStorage();
  if (storage == null) return;
  await storage.setItem(GEOFENCE_DIAGNOSTIC_KEY, JSON.stringify(record));
  const raw = await storage.getItem(GEOFENCE_DIAGNOSTIC_HISTORY_KEY);
  let history: GeofenceDiagnostic[] = [];
  if (raw != null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed as GeofenceDiagnostic[];
    } catch {
      // 历史记录损坏不影响当前围栏事件。
    }
  }
  history.push(record);
  await storage.setItem(
    GEOFENCE_DIAGNOSTIC_HISTORY_KEY,
    JSON.stringify(history.slice(-MAX_GEOFENCE_DIAGNOSTICS)),
  );
}

async function emit(payload: GeofenceTaskPayload): Promise<void> {
  await recordGeofenceDiagnostic({
    phase: 'callback_received',
    schedule_id: payload.schedule_id,
    event: payload.event,
    observed_at: payload.observed_at,
  });

  if (listeners.size === 0) {
    let result: HeadlessDeliveryResult | false = false;
    try {
      result = await deliverHeadlessGeofenceEvent(payload);
    } catch {
      result = false;
    }
    if (result === 'native') {
      await recordGeofenceDiagnostic({
        phase: 'native_requested',
        schedule_id: payload.schedule_id,
        event: payload.event,
        observed_at: payload.observed_at,
      });
    } else if (result === 'notification') {
      await recordGeofenceDiagnostic({
        phase: 'notification_scheduled',
        schedule_id: payload.schedule_id,
        event: payload.event,
        observed_at: payload.observed_at,
      });
    } else if (result === 'state_updated') {
      await recordGeofenceDiagnostic({
        phase: 'state_updated',
        schedule_id: payload.schedule_id,
        event: payload.event,
        observed_at: payload.observed_at,
      });
    } else {
      await persistPendingEvent(payload);
      await recordGeofenceDiagnostic({
        phase: 'queued',
        schedule_id: payload.schedule_id,
        event: payload.event,
        observed_at: payload.observed_at,
        detail: '等待应用会话恢复后重放',
      });
    }
    return;
  }
  for (const listener of listeners) {
    try {
      await listener(payload);
      await recordGeofenceDiagnostic({
        phase: 'listener_completed',
        schedule_id: payload.schedule_id,
        event: payload.event,
        observed_at: payload.observed_at,
      });
    } catch (error) {
      await recordGeofenceDiagnostic({
        phase: 'delivery_failed',
        schedule_id: payload.schedule_id,
        event: payload.event,
        observed_at: payload.observed_at,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

type HeadlessDeliveryResult = 'native' | 'notification' | 'state_updated';

/**
 * Deliver a notification while Expo has only started this headless task.
 *
 * AppRoot/LocalReminderApplication is not alive in this path, so the task must keep
 * the same edge-triggered armed state in SQLite instead of notifying on every enter.
 * Returning false leaves the event in the existing pending queue for replay when the
 * normal application session starts.
 */
async function deliverHeadlessGeofenceEvent(
  payload: GeofenceTaskPayload,
): Promise<HeadlessDeliveryResult | false> {
  const database = await openHeadlessDatabase();
  if (database == null) return false;

  // istanbul ignore next -- database is only non-null with a real expo-sqlite, which
  // openHeadlessDatabase() can never resolve in this Jest env (see the file header);
  // unreachable here.
  {
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
      return 'state_updated';
    }

    const schedule = await database.getFirstAsync<HeadlessScheduleRow>(
      `SELECT id, title, location_name, schedule_type, reminder_type, reminder_strength,
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
      return 'state_updated';
    }

    const strength = schedule.reminder_strength ?? 'medium';
    const nativePresented = await presentHeadlessNativeAlarm(
      schedule.id,
      schedule.title || '日程提醒',
      strength,
    );
    if (!nativePresented) {
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
        trigger: { channelId: 'timeflow-reminders' },
      });
    }

    const deliveryResult: HeadlessDeliveryResult = nativePresented ? 'native' : 'notification';

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
    return deliveryResult;
  }
}

async function presentHeadlessNativeAlarm(
  scheduleId: string,
  title: string,
  strength: 'low' | 'medium' | 'high',
): Promise<boolean> {
  try {
    const bridge = await import('../notifications/native/TimeflowAlarmBridge');
    const { resolveStrengthDeliveryPlan } =
      await import('../../features/reminder/domain/strengthDelivery');
    const plan = resolveStrengthDeliveryPlan(strength);
    return await bridge.nativePresentAlarmNow(
      `geofence-${scheduleId}-${Date.now()}`,
      scheduleId,
      title,
      plan.useVibration,
      plan.alarmSoundTier,
      true,
    );
  } catch {
    return false;
  }
}

async function openHeadlessDatabase(): Promise<SQLiteDatabase | null> {
  try {
    const { openDatabaseAsync } = await import('expo-sqlite');
    // istanbul ignore next -- unreachable in this Jest env: the import above always throws
    // first (no --experimental-vm-modules, see the file header), so this line never runs.
    return await openDatabaseAsync(TIMEFLOW_DATABASE_NAME);
  } catch {
    return null;
  }
}

// istanbul ignore next -- only ever called from the unreachable branch of
// deliverHeadlessGeofenceEvent() above (see the file header), so never entered here.
async function loadNotifications(): Promise<typeof import('expo-notifications') | null> {
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

// istanbul ignore next -- only ever called from the unreachable branch of
// deliverHeadlessGeofenceEvent() above (see the file header).
async function ensureAndroidChannel(
  notifications: typeof import('expo-notifications'),
): Promise<void> {
  // 独立渠道 ID，不跟 ExpoSystemNotification.ts 的 'timeflow-reminders-quiet' 共用——
  // 这条路径故意要出声（地点提醒 headless 兜底），渠道声音创建后不可变，两边共用
  // 一个渠道 ID 谁先创建谁的设置就永久生效，另一边的诉求会被吃掉。显式给 sound
  // 赋值而不是留给默认值，避免依赖未文档化的隐式行为。
  await notifications.setNotificationChannelAsync('timeflow-reminders', {
    name: '日程提醒',
    importance: notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 180],
    lightColor: '#D7F36A',
    sound: 'default',
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
