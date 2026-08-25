import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Sentry from '@sentry/react-native';

import { SentryClientTelemetry } from '../../../../src/infrastructure/observability/SentryClientTelemetry';

jest.mock('@sentry/react-native');

const mockedScope = (
  Sentry as typeof Sentry & {
    mockedScope: { setLevel: jest.Mock; setTag: jest.Mock };
  }
).mockedScope;

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
    telemetry.recordReminderDelivery({
      channel: 'popup',
      manufacturer: 'huawei',
      outcome: 'js_channel',
      overlay_failed: false,
      schedule_type: 'location',
      strength: 'high',
      used_fallback_audio: true,
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith('timeflow.reminder.delivery');
    expect(mockedScope.setLevel).toHaveBeenCalledWith('info');
    expect(Object.fromEntries(mockedScope.setTag.mock.calls)).toEqual({
      channel: 'popup',
      manufacturer: 'huawei',
      outcome: 'js_channel',
      overlay_failed: 'false',
      schedule_type: 'location',
      strength: 'high',
      used_fallback_audio: 'true',
    });
  });

  it('records native_declined as a warning issue', () => {
    telemetry.recordReminderDelivery({
      channel: 'native_full_screen',
      manufacturer: 'xiaomi',
      outcome: 'native_declined',
      overlay_failed: false,
      schedule_type: 'time',
      strength: 'medium',
      used_fallback_audio: false,
    });

    expect(mockedScope.setLevel).toHaveBeenCalledWith('warning');
    expect(mockedScope.setTag).toHaveBeenCalledWith('outcome', 'native_declined');
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
