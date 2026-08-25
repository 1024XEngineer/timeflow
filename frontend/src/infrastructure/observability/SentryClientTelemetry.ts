import * as Sentry from '@sentry/react-native';

import type {
  ClientTelemetryPort,
  DeviceTelemetryContext,
  ReminderDeliveryTelemetry,
  ReminderPermissionBlockedTelemetry,
} from '../../shared/observability';
import { boundPermissions } from '../../shared/observability';

const EVENT_REMINDER_DELIVERY = 'timeflow.reminder.delivery';
const EVENT_REMINDER_PERMISSION = 'timeflow.reminder.permission_blocked';
const EVENT_REMINDER_ERROR = 'timeflow.reminder.delivery';

function flag(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

function deliveryLevel(event: ReminderDeliveryTelemetry): 'info' | 'warning' {
  if (event.overlay_failed) return 'warning';
  if (event.outcome === 'native_ok' || event.outcome === 'js_channel') return 'info';
  return 'warning';
}

function capture(
  message: string,
  level: 'info' | 'warning' | 'error',
  tags: Record<string, string>,
): void {
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    for (const [key, value] of Object.entries(tags)) {
      scope.setTag(key, value);
    }
    Sentry.captureMessage(message);
  });
}

/** Sentry 适配器：只打封闭枚举 tag，不设 user，不带标题/原文/坐标。 */
export class SentryClientTelemetry implements ClientTelemetryPort {
  setDeviceContext(context: DeviceTelemetryContext): void {
    Sentry.setTag('manufacturer', context.manufacturer);
    Sentry.setTag('os', context.os);
  }

  recordReminderDelivery(event: ReminderDeliveryTelemetry): void {
    capture(EVENT_REMINDER_DELIVERY, deliveryLevel(event), {
      channel: event.channel,
      manufacturer: event.manufacturer,
      outcome: event.outcome,
      overlay_failed: flag(event.overlay_failed),
      schedule_type: event.schedule_type,
      strength: event.strength,
      used_fallback_audio: flag(event.used_fallback_audio),
    });
  }

  recordReminderPermissionBlocked(event: ReminderPermissionBlockedTelemetry): void {
    const missing = boundPermissions(event.missing);
    if (missing.length === 0) return;
    capture(EVENT_REMINDER_PERMISSION, 'warning', {
      manufacturer: event.manufacturer,
      missing_permissions: missing.join(','),
    });
  }

  recordUnexpectedError(kind: 'reminder_delivery'): void {
    capture(EVENT_REMINDER_ERROR, 'error', {
      error_kind: 'exception',
      source: kind,
    });
  }
}
