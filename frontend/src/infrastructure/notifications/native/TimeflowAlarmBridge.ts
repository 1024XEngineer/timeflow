import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

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
  consumeNativeDispositions?: () => Promise<NativeAlarmDispositionPayload[]>;
  addListener?: (eventName: string) => void;
  removeListeners?: (count: number) => void;
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

const EVENT_NAME = 'TimeflowAlarmEvent';

const NativeAlarm = NativeModules.TimeflowAlarm as TimeflowAlarmNative | undefined;

export function isTimeflowAlarmAvailable(): boolean {
  return Platform.OS === 'android' && NativeAlarm != null;
}

export async function nativeScheduleAlarm(
  triggerAtMillis: number,
  title: string,
): Promise<string | null> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) return null;
  try {
    const result = await NativeAlarm.schedule(triggerAtMillis, title);
    const alarmId = result?.alarmId;
    if (alarmId == null || alarmId.length === 0) return null;
    return alarmId;
  } catch {
    return null;
  }
}

export async function nativeCancelAlarm(alarmId: string | null | undefined): Promise<boolean> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null || !alarmId) return false;
  try {
    return Boolean(await NativeAlarm.cancel(alarmId));
  } catch {
    return false;
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

export async function nativeConsumeAlarmDispositions(): Promise<NativeAlarmDispositionPayload[]> {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) return [];
  if (NativeAlarm.consumeNativeDispositions == null) return [];
  try {
    return await NativeAlarm.consumeNativeDispositions();
  } catch {
    return [];
  }
}

export function subscribeNativeAlarmEvents(
  listener: (event: NativeAlarmEventPayload) => void,
): () => void {
  if (!isTimeflowAlarmAvailable() || NativeAlarm == null) {
    return () => undefined;
  }
  try {
    const emitter = new NativeEventEmitter(NativeAlarm as never);
    const subscription = emitter.addListener(EVENT_NAME, (payload: NativeAlarmEventPayload) => {
      if (
        payload?.type !== 'fired' &&
        payload?.type !== 'dismissed' &&
        payload?.type !== 'snoozed'
      ) {
        return;
      }
      listener(payload);
    });
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}
