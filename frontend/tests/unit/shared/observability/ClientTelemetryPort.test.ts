import { describe, expect, it } from '@jest/globals';

import {
  NOOP_CLIENT_TELEMETRY,
  boundAppState,
  boundManufacturer,
  boundNativeBackgroundResult,
  boundOs,
  boundPermissions,
  countBucket,
  isLateLatency,
  latencyBucket,
  latencyBucketFromTimes,
} from '../../../../src/shared/observability';

describe('device telemetry tags', () => {
  it('maps unknown or null manufacturers to other', () => {
    expect(boundManufacturer('xiaomi')).toBe('xiaomi');
    expect(boundManufacturer('Huawei')).toBe('other');
    expect(boundManufacturer(null)).toBe('other');
    expect(boundManufacturer('samsung')).toBe('other');
  });

  it('maps platform strings to a closed os enum', () => {
    expect(boundOs('android')).toBe('android');
    expect(boundOs('ios')).toBe('ios');
    expect(boundOs('web')).toBe('web');
    expect(boundOs('macos')).toBe('other');
    expect(boundOs(undefined)).toBe('other');
  });

  it('maps app state strings to a closed enum', () => {
    expect(boundAppState('active')).toBe('active');
    expect(boundAppState('background')).toBe('background');
    expect(boundAppState('unknown')).toBe('unknown');
    expect(boundAppState('extension')).toBe('unknown');
  });

  it('keeps only the closed permission names, in stable order', () => {
    expect(boundPermissions(['overlay', 'unknown', 'exact_alarm'])).toEqual([
      'exact_alarm',
      'overlay',
    ]);
  });

  it('buckets delivery delay without exposing raw timestamps', () => {
    expect(latencyBucket(12_000)).toBe('on_time');
    expect(latencyBucket(45_000)).toBe('late_1m');
    expect(latencyBucket(3 * 60_000)).toBe('late_5m');
    expect(latencyBucket(12 * 60_000)).toBe('late_30m');
    expect(latencyBucket(2 * 60 * 60_000)).toBe('late_hour_plus');
    expect(latencyBucketFromTimes('2026-08-18T10:00:00.000Z', '2026-08-18T10:30:00.000Z')).toBe(
      'late_30m',
    );
  });

  it('buckets counts and native background results', () => {
    expect(countBucket(0)).toBe('none');
    expect(countBucket(1)).toBe('one');
    expect(countBucket(3)).toBe('few');
    expect(countBucket(9)).toBe('many');
    expect(boundNativeBackgroundResult('service_denied')).toBe('service_denied');
    expect(boundNativeBackgroundResult('fallback_notification')).toBe('fallback_notification');
    expect(boundNativeBackgroundResult('boom')).toBeNull();
    expect(boundNativeBackgroundResult(null)).toBeNull();
  });

  it('classifies late buckets without exposing raw delay', () => {
    expect(isLateLatency('on_time')).toBe(false);
    expect(isLateLatency('unknown')).toBe(false);
    expect(isLateLatency('late_1m')).toBe(true);
    expect(latencyBucket(null)).toBe('unknown');
    expect(latencyBucket(Number.NaN)).toBe('unknown');
    expect(latencyBucketFromTimes(null, '2026-08-18T10:00:00.000Z')).toBe('unknown');
    expect(latencyBucketFromTimes('not-a-date', 'also-bad')).toBe('unknown');
  });

  it('exposes a no-op adapter that swallows every port call', () => {
    expect(() => {
      NOOP_CLIENT_TELEMETRY.setDeviceContext({ manufacturer: 'other', os: 'android' });
      NOOP_CLIENT_TELEMETRY.recordReminderDelivery({
        app_state: 'active',
        channel: 'popup',
        deferred_until_foreground: false,
        latency_bucket: 'on_time',
        manufacturer: 'other',
        native_armed: false,
        outcome: 'js_channel',
        overlay_failed: false,
        schedule_type: 'time',
        strength: 'low',
        trigger_source: 'js_time',
        used_fallback_audio: false,
      });
      NOOP_CLIENT_TELEMETRY.recordReminderPermissionBlocked({
        manufacturer: 'other',
        missing: ['overlay'],
      });
      NOOP_CLIENT_TELEMETRY.recordReminderLifecycle({
        background_duration_bucket: 'on_time',
        kind: 'foreground_resume',
        manufacturer: 'other',
        overdue_unarmed: 'none',
      });
      NOOP_CLIENT_TELEMETRY.recordReminderNativeBackground({
        manufacturer: 'other',
        result: 'present_failed',
      });
      NOOP_CLIENT_TELEMETRY.recordUnexpectedError('reminder_delivery');
    }).not.toThrow();
  });
});
