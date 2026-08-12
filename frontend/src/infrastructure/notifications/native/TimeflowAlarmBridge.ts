import { NativeModules, Platform } from 'react-native';

export type NativeAlarmPermissionStatus = {
  exactAlarm: boolean;
  overlay: boolean;
  fullScreen: boolean;
  notifications: boolean;
  battery: boolean;
};

type TimeflowAlarmNative = {
  schedule: (triggerAtMillis: number, title?: string | null) => Promise<{ alarmId: string }>;
  cancel: (alarmId: string) => Promise<boolean>;
  getPermissionStatus: () => Promise<NativeAlarmPermissionStatus>;
  openPermissionSettings: (
    kind: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app',
  ) => Promise<boolean>;
  requestNotificationPermission: () => Promise<boolean>;
};

const NativeAlarm = NativeModules.TimeflowAlarm as TimeflowAlarmNative | undefined;

export function isTimeflowAlarmAvailable(): boolean {
  return Platform.OS === 'android' && NativeAlarm != null;
}

export async function nativeScheduleAlarm(
  triggerAtMillis: number,
  title: string,
): Promise<string | null> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) return null;
  const result = await NativeAlarm.schedule(triggerAtMillis, title);
  return result.alarmId;
}

export async function nativeCancelAlarm(alarmId: string | null | undefined): Promise<void> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null || !alarmId) return;
  try {
    await NativeAlarm.cancel(alarmId);
  } catch {
    // Best-effort cancel.
  }
}

export async function nativeGetAlarmPermissionStatus(): Promise<NativeAlarmPermissionStatus | null> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) return null;
  return NativeAlarm.getPermissionStatus();
}

export async function nativeOpenAlarmPermissionSettings(
  kind: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app',
): Promise<boolean> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) return false;
  return NativeAlarm.openPermissionSettings(kind);
}

export async function nativeRequestNotificationPermission(): Promise<boolean> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) return false;
  return NativeAlarm.requestNotificationPermission();
}

export async function nativeAreAlarmPermissionsGranted(): Promise<boolean> {
  const status = await nativeGetAlarmPermissionStatus();
  if (status == null) return false;
  // 挂闹钟的最低要求：精确闹钟 + 通知；悬浮窗/全屏/电池影响展示，不阻塞调度。
  return status.exactAlarm && status.notifications;
}
