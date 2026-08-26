import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Sentry from '@sentry/react-native';

import { SentryClientTelemetry } from '../../../../src/infrastructure/observability/SentryClientTelemetry';
import type { ReminderDeliveryTelemetry } from '../../../../src/shared/observability';

jest.mock('@sentry/react-native');

const mockedScope = (
  Sentry as typeof Sentry & {
    mockedScope: { setLevel: jest.Mock; setTag: jest.Mock };
  }
).mockedScope;

function delivery(
  overrides: Partial<ReminderDeliveryTelemetry> = {},
): ReminderDeliveryTelemetry {
  return {
    app_state: 'active',
    channel: 'popup',
    deferred_until_foreground: false,
    latency_bucket: 'on_time',
    manufacturer: 'huawei',
    native_armed: false,
    outcome: 'js_channel',
    overlay_failed: false,
    schedule_type: 'location',
    strength: 'high',
    trigger_source: 'location',
    used_fallback_audio: true,
    ...overrides,
  };
}

describe('SentryClientTelemetry', () => {
  const telemetry = new SentryClientTelemetry();

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('sets manufacturer and os as global tags', () => {
    telemetry.setDeviceContext({ manufacturer: 'xiaomi', os: 'android' });
    expect(Sentry.setTag).toHaveBeenCalledWith('manufacturer', 'xiaomi');
    expect(Sentry.setTag).toHaveBeenCalledWith('os', 'android');
  });

  it('records reminder delivery with closed-enum tags and an info level for js_channel', () => {
    telemetry.recordReminderDelivery(delivery());

    expect(Sentry.captureMessage).toHaveBeenCalledWith('timeflow.reminder.delivery');
    expect(mockedScope.setLevel).toHaveBeenCalledWith('info');
    expect(Object.fromEntries(mockedScope.setTag.mock.calls)).toEqual({
      app_state: 'active',
      channel: 'popup',
      deferred_until_foreground: 'false',
      latency_bucket: 'on_time',
      manufacturer: 'huawei',
      native_armed: 'false',
      outcome: 'js_channel',
      overlay_failed: 'false',
      schedule_type: 'location',
      strength: 'high',
      trigger_source: 'location',
      used_fallback_audio: 'true',
    });
  });

  it('records deferred_until_foreground as a warning issue', () => {
    telemetry.recordReminderDelivery(
      delivery({
        deferred_until_foreground: true,
        latency_bucket: 'late_30m',
        outcome: 'js_channel',
        schedule_type: 'time',
        trigger_source: 'js_time',
      }),
    );

    expect(mockedScope.setLevel).toHaveBeenCalledWith('warning');
    expect(mockedScope.setTag).toHaveBeenCalledWith('deferred_until_foreground', 'true');
  });

  it('records native_declined as a warning issue', () => {
    telemetry.recordReminderDelivery(
      delivery({
        channel: 'native_full_screen',
        manufacturer: 'xiaomi',
        outcome: 'native_declined',
        schedule_type: 'time',
        strength: 'medium',
        trigger_source: 'js_time',
        used_fallback_audio: false,
      }),
    );

    expect(mockedScope.setLevel).toHaveBeenCalledWith('warning');
    expect(mockedScope.setTag).toHaveBeenCalledWith('outcome', 'native_declined');
  });

  it('records native background failures without a schedule id', () => {
    telemetry.recordReminderNativeBackground({
      manufacturer: 'xiaomi',
      result: 'service_denied',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith('timeflow.reminder.native_background');
    expect(mockedScope.setLevel).toHaveBeenCalledWith('error');
    expect(Object.fromEntries(mockedScope.setTag.mock.calls)).toEqual({
      manufacturer: 'xiaomi',
      result: 'service_denied',
    });
    expect(JSON.stringify(mockedScope.setTag.mock.calls)).not.toContain('schedule');
  });

  it('records overdue unarmed resumes as warnings', () => {
    telemetry.recordReminderLifecycle({
      background_duration_bucket: 'late_5m',
      kind: 'foreground_resume',
      manufacturer: 'oppo',
      overdue_unarmed: 'one',
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith('timeflow.reminder.foreground_resume');
    expect(mockedScope.setLevel).toHaveBeenCalledWith('warning');
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'app.lifecycle', message: 'foreground_resume' }),
    );
  });

  it('does not attach a title or schedule id when recording a permission gap', () => {
    telemetry.recordReminderPermissionBlocked({
      manufacturer: 'oppo',
      missing: ['exact_alarm', 'overlay'],
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith('timeflow.reminder.permission_blocked');
    expect(Object.fromEntries(mockedScope.setTag.mock.calls)).toEqual({
      manufacturer: 'oppo',
      missing_permissions: 'exact_alarm,overlay',
    });
    expect(JSON.stringify(mockedScope.setTag.mock.calls)).not.toContain('schedule');
  });
});
