import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type BaiduLocationSample = {
  latitude: number;
  longitude: number;
  accuracy: number;
  observedAt: string;
  locType?: number;
};

type TimeflowBaiduLocationNative = {
  setAgreePrivacy: (agree: boolean) => Promise<boolean>;
  init: (ak: string | null) => Promise<boolean>;
  startUpdating: (intervalMs: number) => Promise<boolean>;
  stopUpdating: () => Promise<boolean>;
  getCurrentPosition: () => Promise<BaiduLocationSample | null>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

const Native = NativeModules.TimeflowBaiduLocation as TimeflowBaiduLocationNative | undefined;

function getNative(): TimeflowBaiduLocationNative | undefined {
  return NativeModules.TimeflowBaiduLocation as TimeflowBaiduLocationNative | undefined;
}

export function isBaiduLocationAvailable(): boolean {
  return Platform.OS === 'android' && getNative() != null;
}

export async function baiduSetAgreePrivacy(agree: boolean): Promise<void> {
  const native = getNative();
  if (native == null) return;
  await native.setAgreePrivacy(agree);
}

export async function baiduInit(ak: string | null = null): Promise<boolean> {
  const native = getNative();
  if (native == null) return false;
  await native.setAgreePrivacy(true);
  return native.init(ak);
}

export async function baiduStartUpdating(intervalMs = 5_000): Promise<boolean> {
  const native = getNative();
  if (native == null) return false;
  return native.startUpdating(intervalMs);
}

export async function baiduStopUpdating(): Promise<void> {
  const native = getNative();
  if (native == null) return;
  await native.stopUpdating();
}

export async function baiduGetCurrentPosition(): Promise<BaiduLocationSample | null> {
  const native = getNative();
  if (native == null) return null;
  return native.getCurrentPosition();
}

export function subscribeBaiduLocation(
  listener: (sample: BaiduLocationSample) => void,
): () => void {
  const native = getNative();
  if (native == null || Platform.OS !== 'android') {
    return () => {};
  }
  const emitter = new NativeEventEmitter(native as never);
  const sub = emitter.addListener('TimeflowBaiduLocation', (payload: BaiduLocationSample) => {
    if (
      payload == null ||
      typeof payload.latitude !== 'number' ||
      typeof payload.longitude !== 'number'
    ) {
      return;
    }
    listener(payload);
  });
  return () => sub.remove();
}

export { Native as TimeflowBaiduLocationNativeModule };
