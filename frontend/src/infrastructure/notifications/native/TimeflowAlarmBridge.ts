import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { AlarmSoundTier } from '../../../features/reminder/domain/strengthDelivery';

export type NativeAlarmPermissionStatus = {
  exactAlarm: boolean;
  overlay: boolean;
  fullScreen: boolean;
  notifications: boolean;
  battery: boolean;
  /** 只有小米/华为/OPPO/vivo 四家会识别出来；其余机型/无法判断时是 null。 */
  manufacturer: 'xiaomi' | 'huawei' | 'oppo' | 'vivo' | null;
  /** 没有标准 API 能查真实授权状态，这三项只表示"带没带用户跳过对应设置页"。 */
  oemAutostartGuided: boolean;
  oemBackgroundPopupGuided: boolean;
  oemLastOverlayFailed: boolean;
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
    vibrate?: boolean,
    soundTier?: AlarmSoundTier,
    fullScreen?: boolean,
    speechText?: string | null,
  ) => Promise<{ alarmId: string; scheduleId?: string }>;
  cancel: (alarmId: string) => Promise<boolean>;
  cancelAll: () => Promise<number>;
  stopRinging: () => Promise<boolean>;
  presentNow: (
    alarmId: string,
    scheduleId: string,
    title: string,
    vibrate: boolean,
    soundTier: AlarmSoundTier,
    fullScreen: boolean,
    speechText?: string | null,
  ) => Promise<boolean>;
  hasArmedAlarm: (scheduleId: string) => Promise<boolean>;
  peekNativeDispositions: () => Promise<NativeAlarmDispositionPayload[]>;
  ackNativeDispositions: (scheduleIds: string[]) => Promise<boolean>;
  getPermissionStatus: () => Promise<NativeAlarmPermissionStatus>;
  openPermissionSettings: (
    kind:
      'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app' | 'autostart' | 'backgroundPopup',
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
  vibrate?: boolean,
  soundTier?: AlarmSoundTier,
  fullScreen?: boolean,
  speechText?: string | null,
): Promise<string | null> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return null;
  try {
    const result = await native.schedule(
      triggerAtMillis,
      title,
      scheduleId ?? '',
      vibrate ?? true,
      soundTier ?? 'full',
      fullScreen ?? true,
      speechText ?? '',
    );
    return result.alarmId;
  } catch (error) {
    // 临时诊断日志：定位"原生闹钟排不上"到底是权限拒绝、触发时间已过，
    // 还是 JS<->原生桥接调用本身抛了异常（比如原生端还是旧签名，参数对不上）。
    console.warn('[TimeflowAlarm] nativeScheduleAlarm failed', error);
    return null;
  }
}

export async function nativeCancelAlarm(alarmId: string | null | undefined): Promise<boolean> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null || !alarmId) return false;
  try {
    return await native.cancel(alarmId);
  } catch {
    return false;
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

export async function nativePresentAlarmNow(
  alarmId: string,
  scheduleId: string,
  title: string,
  vibrate: boolean,
  soundTier: AlarmSoundTier,
  fullScreen: boolean,
  speechText?: string | null,
): Promise<boolean> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return false;
  try {
    return await native.presentNow(
      alarmId,
      scheduleId,
      title,
      vibrate,
      soundTier,
      fullScreen,
      speechText ?? '',
    );
  } catch (error) {
    console.warn('[TimeflowAlarm] nativePresentAlarmNow failed', error);
    return false;
  }
}

export async function nativeHasArmedAlarm(scheduleId: string): Promise<boolean> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null || !scheduleId) return false;
  try {
    return await native.hasArmedAlarm(scheduleId);
  } catch {
    return false;
  }
}

export async function nativePeekAlarmDispositions(): Promise<NativeAlarmDispositionPayload[]> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return [];
  try {
    return await native.peekNativeDispositions();
  } catch {
    return [];
  }
}

export async function nativeAckAlarmDispositions(scheduleIds: readonly string[]): Promise<void> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null || scheduleIds.length === 0) return;
  try {
    await native.ackNativeDispositions([...scheduleIds]);
  } catch {
    // 确认失败就不清缓冲区，下次冷启动重新 peek 到、重放同样的幂等状态转换。
  }
}

export async function nativeGetAlarmPermissionStatus(): Promise<NativeAlarmPermissionStatus | null> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return null;
  try {
    return await native.getPermissionStatus();
  } catch {
    return null;
  }
}

export async function nativeOpenAlarmPermissionSettings(
  kind:
    'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app' | 'autostart' | 'backgroundPopup',
): Promise<boolean> {
  const native = getNativeAlarm();
  if (!isTimeflowAlarmAvailable() || native == null) return false;
  try {
    return await native.openPermissionSettings(kind);
  } catch {
    return false;
  }
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
