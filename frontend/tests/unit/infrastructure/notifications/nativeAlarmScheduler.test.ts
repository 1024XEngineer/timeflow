import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules, Platform } from 'react-native';

import type { AlarmScheduleRequest } from '../../../../src/features/reminder/application/interfaces';
import { NativeAlarmScheduler } from '../../../../src/infrastructure/notifications/NativeAlarmScheduler';
import {
  isTimeflowAlarmAvailable,
  nativeAreAlarmPermissionsGranted,
  nativeCancelAlarm,
  nativeScheduleAlarm,
} from '../../../../src/infrastructure/notifications/native/TimeflowAlarmBridge';

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native') as typeof import('react-native');
  RN.NativeModules.TimeflowAlarm = {
    schedule: jest.fn(),
    cancel: jest.fn(),
    cancelAll: jest.fn(),
    stopRinging: jest.fn(),
    consumeNativeDispositions: jest.fn(),
    getPermissionStatus: jest.fn(),
    openPermissionSettings: jest.fn(),
    requestNotificationPermission: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return RN;
});

type NativeAlarmMock = {
  schedule: jest.MockedFunction<
    (
      triggerAtMillis: number,
      title?: string | null,
      scheduleId?: string | null,
    ) => Promise<{ alarmId: string; scheduleId?: string }>
  >;
  cancel: jest.MockedFunction<(alarmId: string) => Promise<boolean>>;
  cancelAll: jest.MockedFunction<() => Promise<number>>;
  stopRinging: jest.MockedFunction<() => Promise<boolean>>;
  consumeNativeDispositions: jest.MockedFunction<
    () => Promise<{ scheduleId: string; alarmId: string; state: string; updatedAtMillis: number }[]>
  >;
  getPermissionStatus: jest.MockedFunction<
    () => Promise<{
      exactAlarm: boolean;
      overlay: boolean;
      fullScreen: boolean;
      notifications: boolean;
      battery: boolean;
    }>
  >;
};

const NOW = '2026-08-13T08:00:00.000Z';
const FUTURE = '2026-08-13T09:00:00.000Z';
const PAST = '2026-08-13T07:00:00.000Z';

const native = NativeModules.TimeflowAlarm as NativeAlarmMock;

function request(overrides: Partial<AlarmScheduleRequest> = {}): AlarmScheduleRequest {
  return {
    schedule_id: 'schedule-1',
    trigger_at: FUTURE,
    title: '晨会',
    exact: true,
    ...overrides,
  };
}

function grantPermissions(
  overrides: Partial<{
    exactAlarm: boolean;
    overlay: boolean;
    fullScreen: boolean;
    notifications: boolean;
    battery: boolean;
  }> = {},
) {
  native.getPermissionStatus.mockResolvedValue({
    exactAlarm: true,
    overlay: false,
    fullScreen: false,
    notifications: true,
    battery: false,
    ...overrides,
  });
}

describe('TimeflowAlarmBridge and NativeAlarmScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
    Platform.OS = 'android';
    native.schedule.mockReset();
    native.cancel.mockReset();
    native.cancelAll.mockReset();
    native.stopRinging.mockReset();
    native.consumeNativeDispositions.mockReset();
    native.getPermissionStatus.mockReset();
    grantPermissions();
    native.schedule.mockResolvedValue({ alarmId: 'alarm-1', scheduleId: 'schedule-1' });
    native.cancel.mockResolvedValue(true);
    native.cancelAll.mockResolvedValue(0);
    native.stopRinging.mockResolvedValue(true);
    native.consumeNativeDispositions.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
    Platform.OS = 'android';
  });

  it('reports the bridge unavailable off Android', () => {
    Platform.OS = 'ios';
    expect(isTimeflowAlarmAvailable()).toBe(false);
  });

  it('returns unscheduled when the native module is unavailable', async () => {
    Platform.OS = 'ios';
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    expect(native.getPermissionStatus).not.toHaveBeenCalled();
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('returns unscheduled for an invalid trigger time', async () => {
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request({ trigger_at: 'not-a-date' }))).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('returns unscheduled for a trigger at or before now', async () => {
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request({ trigger_at: PAST }))).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    await expect(scheduler.schedule(request({ trigger_at: NOW }))).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('returns unscheduled when exact-alarm permission is missing', async () => {
    grantPermissions({ exactAlarm: false });
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('returns unscheduled when notification permission is missing', async () => {
    grantPermissions({ notifications: false });
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('does not require overlay, full-screen, or battery permission to schedule', async () => {
    grantPermissions({ overlay: false, fullScreen: false, battery: false });
    await expect(nativeAreAlarmPermissionsGranted()).resolves.toBe(true);
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: 'alarm-1',
      schedule_id: 'schedule-1',
      scheduled: true,
    });
  });

  it('schedules a future alarm and returns scheduled: true', async () => {
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: 'alarm-1',
      schedule_id: 'schedule-1',
      scheduled: true,
    });
    expect(native.schedule).toHaveBeenCalledWith(Date.parse(FUTURE), '晨会', 'schedule-1');
  });

  it('maps a native schedule rejection to unscheduled', async () => {
    native.schedule.mockRejectedValue(new Error('exact alarm denied'));
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    await expect(nativeScheduleAlarm(Date.parse(FUTURE), '晨会')).resolves.toBeNull();
  });

  it('maps an empty native alarm id to unscheduled', async () => {
    native.schedule.mockResolvedValue({ alarmId: '' });
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
  });

  it('maps a permission-status rejection to unscheduled', async () => {
    native.getPermissionStatus.mockRejectedValue(new Error('status unavailable'));
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.schedule(request())).resolves.toEqual({
      alarm_id: '',
      schedule_id: 'schedule-1',
      scheduled: false,
    });
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('treats native cancel as cancelled: true even when the bridge swallows errors', async () => {
    const scheduler = new NativeAlarmScheduler();
    native.cancel.mockResolvedValueOnce(true);
    await expect(scheduler.cancel('alarm-1')).resolves.toEqual({ cancelled: true });
    native.cancel.mockRejectedValueOnce(new Error('cancel failed'));
    await expect(scheduler.cancel('alarm-1')).resolves.toEqual({ cancelled: true });
    expect(native.cancel).toHaveBeenCalledTimes(2);
  });

  it('returns cancelled: false when cancel is called with an empty id', async () => {
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.cancel(null)).resolves.toEqual({ cancelled: false });
    await expect(scheduler.cancel('')).resolves.toEqual({ cancelled: false });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it('swallows native cancel failures at the bridge', async () => {
    native.cancel.mockRejectedValue(new Error('cancel failed'));
    await expect(nativeCancelAlarm('alarm-1')).resolves.toBeUndefined();
  });

  it('rebuilds mixed requests in order', async () => {
    native.schedule
      .mockResolvedValueOnce({ alarmId: 'alarm-ok', scheduleId: 'ok' })
      .mockResolvedValueOnce({
        alarmId: 'alarm-later',
        scheduleId: 'later',
      });
    const scheduler = new NativeAlarmScheduler();
    const receipts = await scheduler.rebuild([
      request({ schedule_id: 'ok' }),
      request({ schedule_id: 'expired', trigger_at: PAST }),
      request({ schedule_id: 'later', trigger_at: '2026-08-13T10:00:00.000Z', title: '午会' }),
    ]);
    expect(native.cancelAll).toHaveBeenCalledTimes(1);
    expect(receipts).toEqual([
      { alarm_id: 'alarm-ok', schedule_id: 'ok', scheduled: true },
      { alarm_id: '', schedule_id: 'expired', scheduled: false },
      { alarm_id: 'alarm-later', schedule_id: 'later', scheduled: true },
    ]);
    expect(native.schedule).toHaveBeenCalledTimes(2);
    expect(native.schedule).toHaveBeenNthCalledWith(1, Date.parse(FUTURE), '晨会', 'ok');
    expect(native.schedule).toHaveBeenNthCalledWith(
      2,
      Date.parse('2026-08-13T10:00:00.000Z'),
      '午会',
      'later',
    );
  });

  it('forwards stopRinging and native dispositions', async () => {
    native.consumeNativeDispositions.mockResolvedValue([
      {
        scheduleId: 's1',
        alarmId: 'a1',
        state: 'confirmed',
        updatedAtMillis: Date.parse(NOW),
      },
    ]);
    const scheduler = new NativeAlarmScheduler();
    await scheduler.stopRinging();
    expect(native.stopRinging).toHaveBeenCalledTimes(1);
    await expect(scheduler.consumeNativeDispositions()).resolves.toEqual([
      {
        schedule_id: 's1',
        alarm_id: 'a1',
        state: 'confirmed',
        updated_at: NOW,
      },
    ]);
  });
});
