/** 客户端可观测性端口：features 只记封闭枚举，不依赖 Sentry SDK。 */

export type TelemetryManufacturer = 'xiaomi' | 'huawei' | 'oppo' | 'vivo' | 'other';
export type TelemetryOs = 'android' | 'ios' | 'web' | 'other';

export type ReminderDeliveryOutcome =
  'native_ok' | 'native_declined' | 'native_unavailable' | 'js_channel';

export type ReminderTelemetryChannel =
  'native_full_screen' | 'system_notification' | 'popup' | 'vibration' | 'tts' | 'local_sound';

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
};

export type ReminderPermissionBlockedTelemetry = {
  missing: readonly TelemetryPermission[];
  manufacturer: TelemetryManufacturer;
};

export interface ClientTelemetryPort {
  setDeviceContext(context: DeviceTelemetryContext): void;
  recordReminderDelivery(event: ReminderDeliveryTelemetry): void;
  recordReminderPermissionBlocked(event: ReminderPermissionBlockedTelemetry): void;
  recordUnexpectedError(kind: 'reminder_delivery'): void;
}

export const NOOP_CLIENT_TELEMETRY: ClientTelemetryPort = {
  setDeviceContext() {},
  recordReminderDelivery() {},
  recordReminderPermissionBlocked() {},
  recordUnexpectedError() {},
};

const KNOWN_MANUFACTURERS: ReadonlySet<string> = new Set(['xiaomi', 'huawei', 'oppo', 'vivo']);
const KNOWN_OS: ReadonlySet<string> = new Set(['android', 'ios', 'web']);

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

export function boundPermissions(values: readonly string[]): readonly TelemetryPermission[] {
  const wanted = new Set(values);
  return TELEMETRY_PERMISSIONS.filter((permission) => wanted.has(permission));
}
