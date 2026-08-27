/** 客户端可观测性端口：features 只记封闭枚举，不依赖 Sentry SDK。 */

export type TelemetryManufacturer = 'xiaomi' | 'huawei' | 'oppo' | 'vivo' | 'other';
export type TelemetryOs = 'android' | 'ios' | 'web' | 'other';
export type TelemetryAppState = 'active' | 'background' | 'inactive' | 'unknown';

export type ReminderDeliveryOutcome =
  'native_ok' | 'native_declined' | 'native_unavailable' | 'js_channel';

export type ReminderTelemetryChannel =
  'native_full_screen' | 'system_notification' | 'popup' | 'vibration' | 'tts' | 'local_sound';

export type ReminderTriggerSource =
  'native_alarm' | 'js_time' | 'location' | 'stuck_pending' | 'headless_guard';

export type ReminderLatencyBucket =
  'on_time' | 'late_1m' | 'late_5m' | 'late_30m' | 'late_hour_plus' | 'unknown';

export type ReminderCountBucket = 'none' | 'one' | 'few' | 'many';

export type NativeBackgroundResult = 'service_denied' | 'present_failed' | 'fallback_notification';

export const TELEMETRY_PERMISSIONS = [
  'notifications',
  'exact_alarm',
  'overlay',
  'full_screen',
  'battery_optimization',
  'location_foreground',
  'location_background',
  'microphone',
] as const;

export type TelemetryPermission = (typeof TELEMETRY_PERMISSIONS)[number];

export type DeviceTelemetryContext = {
  manufacturer: TelemetryManufacturer;
  os: TelemetryOs;
};

export type ReminderDeliveryTelemetry = {
  outcome: ReminderDeliveryOutcome;
  channel: ReminderTelemetryChannel;
  schedule_type: 'time' | 'location';
  strength: 'low' | 'medium' | 'high';
  manufacturer: TelemetryManufacturer;
  used_fallback_audio: boolean;
  overlay_failed: boolean;
  app_state: TelemetryAppState;
  trigger_source: ReminderTriggerSource;
  latency_bucket: ReminderLatencyBucket;
  deferred_until_foreground: boolean;
  native_armed: boolean;
};

export type ReminderPermissionBlockedTelemetry = {
  missing: readonly TelemetryPermission[];
  manufacturer: TelemetryManufacturer;
};

export type ReminderLifecycleTelemetry = {
  kind: 'foreground_resume';
  manufacturer: TelemetryManufacturer;
  background_duration_bucket: ReminderLatencyBucket;
  overdue_unarmed: ReminderCountBucket;
};

export type ReminderNativeBackgroundTelemetry = {
  result: NativeBackgroundResult;
  manufacturer: TelemetryManufacturer;
};

export interface ClientTelemetryPort {
  setDeviceContext(context: DeviceTelemetryContext): void;
  recordReminderDelivery(event: ReminderDeliveryTelemetry): void;
  recordReminderPermissionBlocked(event: ReminderPermissionBlockedTelemetry): void;
  recordReminderLifecycle(event: ReminderLifecycleTelemetry): void;
  recordReminderNativeBackground(event: ReminderNativeBackgroundTelemetry): void;
  recordUnexpectedError(kind: 'reminder_delivery'): void;
}

export const NOOP_CLIENT_TELEMETRY: ClientTelemetryPort = {
  setDeviceContext() {},
  recordReminderDelivery() {},
  recordReminderPermissionBlocked() {},
  recordReminderLifecycle() {},
  recordReminderNativeBackground() {},
  recordUnexpectedError() {},
};

const KNOWN_MANUFACTURERS: ReadonlySet<string> = new Set(['xiaomi', 'huawei', 'oppo', 'vivo']);
const KNOWN_OS: ReadonlySet<string> = new Set(['android', 'ios', 'web']);
const KNOWN_APP_STATES: ReadonlySet<string> = new Set(['active', 'background', 'inactive']);
const KNOWN_NATIVE_BACKGROUND: ReadonlySet<string> = new Set([
  'service_denied',
  'present_failed',
  'fallback_notification',
]);

const LATE_BUCKETS: ReadonlySet<ReminderLatencyBucket> = new Set([
  'late_1m',
  'late_5m',
  'late_30m',
  'late_hour_plus',
]);

/** 未识别国产 ROM / 未知字符串一律 other，禁止把 Device.brand 原串当 tag。 */
export function boundManufacturer(value: string | null | undefined): TelemetryManufacturer {
  if (value != null && KNOWN_MANUFACTURERS.has(value)) {
    return value as TelemetryManufacturer;
  }
  return 'other';
}

export function boundOs(value: string | null | undefined): TelemetryOs {
  if (value != null && KNOWN_OS.has(value)) {
    return value as TelemetryOs;
  }
  return 'other';
}

export function boundAppState(value: string | null | undefined): TelemetryAppState {
  if (value != null && KNOWN_APP_STATES.has(value)) {
    return value as TelemetryAppState;
  }
  return 'unknown';
}

export function boundPermissions(values: readonly string[]): readonly TelemetryPermission[] {
  const wanted = new Set(values);
  return TELEMETRY_PERMISSIONS.filter((permission) => wanted.has(permission));
}

export function boundNativeBackgroundResult(
  value: string | null | undefined,
): NativeBackgroundResult | null {
  if (value != null && KNOWN_NATIVE_BACKGROUND.has(value)) {
    return value as NativeBackgroundResult;
  }
  return null;
}

/** JS 30s tick 内算准时；再晚按 1/5/30 分钟分桶，不上报原始毫秒。 */
export function latencyBucket(delayMs: number | null | undefined): ReminderLatencyBucket {
  if (delayMs == null || !Number.isFinite(delayMs)) return 'unknown';
  if (delayMs < 30_000) return 'on_time';
  if (delayMs < 60_000) return 'late_1m';
  if (delayMs < 5 * 60_000) return 'late_5m';
  if (delayMs <= 30 * 60_000) return 'late_30m';
  return 'late_hour_plus';
}

export function latencyBucketFromTimes(
  scheduledAt: string | null | undefined,
  observedAt: string,
): ReminderLatencyBucket {
  if (scheduledAt == null) return 'unknown';
  const scheduledMs = Date.parse(scheduledAt);
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(scheduledMs) || Number.isNaN(observedMs)) return 'unknown';
  return latencyBucket(observedMs - scheduledMs);
}

export function countBucket(count: number): ReminderCountBucket {
  if (count <= 0) return 'none';
  if (count === 1) return 'one';
  if (count <= 4) return 'few';
  return 'many';
}

export function isLateLatency(bucket: ReminderLatencyBucket): boolean {
  return LATE_BUCKETS.has(bucket);
}
