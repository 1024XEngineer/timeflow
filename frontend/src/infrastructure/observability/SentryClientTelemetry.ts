import * as Sentry from '@sentry/react-native';

import type {
  ClientTelemetryPort,
  DeviceTelemetryContext,
  ReminderDeliveryTelemetry,
  ReminderLifecycleTelemetry,
  ReminderNativeBackgroundTelemetry,
  ReminderPermissionBlockedTelemetry,
} from '../../shared/observability';
import { boundPermissions } from '../../shared/observability';

const EVENT_REMINDER_DELIVERY = 'timeflow.reminder.delivery';
const EVENT_REMINDER_PERMISSION = 'timeflow.reminder.permission_blocked';
const EVENT_REMINDER_ERROR = 'timeflow.reminder.delivery';
const EVENT_REMINDER_LIFECYCLE = 'timeflow.reminder.foreground_resume';
const EVENT_REMINDER_NATIVE_BACKGROUND = 'timeflow.reminder.native_background';

function flag(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

function deliveryLevel(event: ReminderDeliveryTelemetry): 'info' | 'warning' {
  if (event.deferred_until_foreground) return 'warning';
  if (event.overlay_failed) return 'warning';
  if (event.outcome === 'native_ok' || event.outcome === 'js_channel') return 'info';
  return 'warning';
}

function lifecycleLevel(event: ReminderLifecycleTelemetry): 'info' | 'warning' {
  return event.overdue_unarmed === 'none' ? 'info' : 'warning';
}

function nativeBackgroundLevel(event: ReminderNativeBackgroundTelemetry): 'warning' | 'error' {
  return event.result === 'fallback_notification' ? 'warning' : 'error';
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
      app_state: event.app_state,
      channel: event.channel,
      deferred_until_foreground: flag(event.deferred_until_foreground),
      latency_bucket: event.latency_bucket,
      manufacturer: event.manufacturer,
      native_armed: flag(event.native_armed),
      outcome: event.outcome,
      overlay_failed: flag(event.overlay_failed),
      schedule_type: event.schedule_type,
      strength: event.strength,
      trigger_source: event.trigger_source,
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

  recordReminderLifecycle(event: ReminderLifecycleTelemetry): void {
    Sentry.addBreadcrumb({
      category: 'app.lifecycle',
      level: 'info',
      message: event.kind,
    });
    capture(EVENT_REMINDER_LIFECYCLE, lifecycleLevel(event), {
      background_duration_bucket: event.background_duration_bucket,
      kind: event.kind,
      manufacturer: event.manufacturer,
      overdue_unarmed: event.overdue_unarmed,
    });
  }

  recordReminderNativeBackground(event: ReminderNativeBackgroundTelemetry): void {
    capture(EVENT_REMINDER_NATIVE_BACKGROUND, nativeBackgroundLevel(event), {
      manufacturer: event.manufacturer,
      result: event.result,
    });
  }

  recordUnexpectedError(kind: 'reminder_delivery'): void {
    capture(EVENT_REMINDER_ERROR, 'error', {
      error_kind: 'exception',
      source: kind,
    });
  }
}
