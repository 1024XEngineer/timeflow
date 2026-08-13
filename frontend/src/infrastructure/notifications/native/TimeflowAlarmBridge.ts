import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type NativeAlarmPermissionStatus = {
  exactAlarm: boolean;
  overlay: boolean;
  fullScreen: boolean;
  notifications: boolean;
  battery: boolean;
};

export type NativeAlarmEventPayload = {
  type: 'fired' | 'dismissed' | 'snoozed';
  scheduleId: string;
  alarmId: string;
  title: string;
  atMillis: number;
};

export type NativeAlarmDispositionPayload = {
  scheduleId: string;
  alarmId: string;
  state: string;
  updatedAtMillis: number;
};

type TimeflowAlarmNative = {
  schedule: (
    triggerAtMillis: number,
    title?: string | null,
    scheduleId?: string | null,
  ) => Promise<{ alarmId: string; scheduleId?: string }>;
  cancel: (alarmId: string) => Promise<boolean>;
  cancelAll: () => Promise<number>;
  stopRinging: () => Promise<boolean>;
  consumeNativeDispositions: () => Promise<NativeAlarmDispositionPayload[]>;
  getPermissionStatus: () => Promise<NativeAlarmPermissionStatus>;
  openPermissionSettings: (
    kind: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app',
  ) => Promise<boolean>;
  requestNotificationPermission: () => Promise<boolean>;
  addListener?: (eventName: string) => void;
  removeListeners?: (count: number) => void;
};

const EVENT_NAME = 'TimeflowAlarmEvent';

function getNativeAlarm(): TimeflowAlarmNative | undefined {
  return NativeModules.TimeflowAlarm as TimeflowAlarmNative | undefined;
}

export function isTimeflowAlarmAvailable(): boolean {
  return Platform.OS === 'android' && getNativeAlarm() != null;
}

export async function nativeScheduleAlarm(
  triggerAtMillis: number,
  title: string,
  scheduleId?: string,
): Promise<string | null> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return null;
  try {
    const result = await native.schedule(triggerAtMillis, title, scheduleId ?? '');
    return result.alarmId;
  } catch {
    return null;
  }
}

export async function nativeCancelAlarm(alarmId: string | null | undefined): Promise<void> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null || !alarmId) return;
  try {
    await native.cancel(alarmId);
  } catch {
    // 尽力取消，忽略失败。
  }
}

export async function nativeCancelAllAlarms(): Promise<void> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return;
  try {
    await native.cancelAll();
  } catch {
    // 尽力全部取消，忽略失败。
  }
}

export async function nativeStopAlarmRinging(): Promise<void> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return;
  try {
    await native.stopRinging();
  } catch {
    // 尽力停铃，忽略失败。
  }
}

export async function nativeConsumeAlarmDispositions(): Promise<NativeAlarmDispositionPayload[]> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return [];
  try {
    return await native.consumeNativeDispositions();
  } catch {
    return [];
  }
}

export async function nativeGetAlarmPermissionStatus(): Promise<NativeAlarmPermissionStatus | null> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return null;
  return native.getPermissionStatus();
}

export async function nativeOpenAlarmPermissionSettings(
  kind: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app',
): Promise<boolean> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return false;
  return native.openPermissionSettings(kind);
}

export async function nativeRequestNotificationPermission(): Promise<boolean> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return false;
  try {
    return await native.requestNotificationPermission();
  } catch {
    return false;
  }
}

export async function nativeAreAlarmPermissionsGranted(): Promise<boolean> {
  const status = await nativeGetAlarmPermissionStatus();
  if (status == null) return false;
  return status.exactAlarm && status.notifications;
}

export function subscribeNativeAlarmEvents(
  listener: (event: NativeAlarmEventPayload) => void,
): () => void {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) {
    return () => undefined;
  }
  const emitter = new NativeEventEmitter(native as never);
  const subscription = emitter.addListener(EVENT_NAME, (payload: NativeAlarmEventPayload) => {
    if (payload?.type !== 'fired' && payload?.type !== 'dismissed' && payload?.type !== 'snoozed') {
      return;
    }
    listener(payload);
  });
  return () => subscription.remove();
}
