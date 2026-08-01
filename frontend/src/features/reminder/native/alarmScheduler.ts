import { NativeModules, Platform } from 'react-native';

type AlarmPermissionStatus = {
  exactAlarm: boolean;
  overlay: boolean;
  fullScreen: boolean;
  notifications: boolean;
  battery: boolean;
};

type TimeflowAlarmNative = {
  schedule: (triggerAtMillis: number, title?: string | null) => Promise<{ alarmId: string }>;
  cancel: (alarmId: string) => Promise<boolean>;
  getPermissionStatus: () => Promise<AlarmPermissionStatus>;
  openPermissionSettings: (
    kind: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app',
  ) => Promise<boolean>;
  requestNotificationPermission: () => Promise<boolean>;
};

const NativeAlarm = NativeModules.TimeflowAlarm as TimeflowAlarmNative | undefined;

export function isAndroidAlarmSupported(): boolean {
  return Platform.OS === 'android' && NativeAlarm != null;
}

export async function scheduleAndroidAlarm(
  triggerAtMillis: number,
  title: string,
): Promise<string | null> {
  if (!isAndroidAlarmSupported() || !NativeAlarm) return null;
  const result = await NativeAlarm.schedule(triggerAtMillis, title);
  return result.alarmId;
}

export async function cancelAndroidAlarm(alarmId: string | null | undefined): Promise<void> {
  if (!isAndroidAlarmSupported() || !NativeAlarm || !alarmId) return;
  try {
    await NativeAlarm.cancel(alarmId);
  } catch {
    // Best-effort cancel; missing records should not block schedule edits.
  }
}

export async function getAndroidAlarmPermissionStatus(): Promise<AlarmPermissionStatus | null> {
  if (!isAndroidAlarmSupported() || !NativeAlarm) return null;
  return NativeAlarm.getPermissionStatus();
}

export async function openAndroidAlarmPermissionSettings(
  kind: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app',
): Promise<void> {
  if (!isAndroidAlarmSupported() || !NativeAlarm) return;
  await NativeAlarm.openPermissionSettings(kind);
}

export async function requestAndroidNotificationPermission(): Promise<boolean> {
  if (!isAndroidAlarmSupported() || !NativeAlarm) return false;
  return NativeAlarm.requestNotificationPermission();
}

/** 静默检查，不弹系统设置页。用于创建日程时。 */
export async function areAndroidAlarmPermissionsGranted(): Promise<boolean> {
  if (!isAndroidAlarmSupported() || !NativeAlarm) return false;
  const status = await NativeAlarm.getPermissionStatus();
  return (
    status.exactAlarm &&
    status.overlay &&
    status.fullScreen &&
    status.notifications &&
    status.battery
  );
}

/**
 * Reminder fires at start_time minus time_remind_offset_minutes.
 * Returns null when no future alarm should be registered.
 */
export function computeScheduleAlarmTriggerMillis(
  startTime: string | null | undefined,
  offsetMinutes: number | null | undefined,
): number | null {
  if (!startTime) return null;
  const startMs = Date.parse(startTime);
  if (!Number.isFinite(startMs)) return null;
  const offset = (offsetMinutes ?? 0) * 60_000;
  const triggerAtMillis = startMs - offset;
  if (triggerAtMillis <= Date.now()) return null;
  return triggerAtMillis;
}
