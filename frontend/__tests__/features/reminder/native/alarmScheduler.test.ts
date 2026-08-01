import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSchedule = jest.fn(async () => ({ alarmId: 'alarm_1' }));
const mockCancel = jest.fn(async () => true);
const mockGetPermissionStatus = jest.fn(async () => ({
  exactAlarm: true,
  overlay: true,
  fullScreen: true,
  notifications: true,
  battery: true,
}));
const mockOpenPermissionSettings = jest.fn(async () => true);
const mockRequestNotificationPermission = jest.fn(async () => true);

jest.mock('react-native', () => ({
  Platform: {
    OS: 'android',
    select: (specs: Record<string, unknown>) => specs.android,
  },
  NativeModules: {
    TimeflowAlarm: {
      schedule: (...args: unknown[]) => (mockSchedule as (...a: unknown[]) => unknown)(...args),
      cancel: (...args: unknown[]) => (mockCancel as (...a: unknown[]) => unknown)(...args),
      getPermissionStatus: (...args: unknown[]) =>
        (mockGetPermissionStatus as (...a: unknown[]) => unknown)(...args),
      openPermissionSettings: (...args: unknown[]) =>
        (mockOpenPermissionSettings as (...a: unknown[]) => unknown)(...args),
      requestNotificationPermission: (...args: unknown[]) =>
        (mockRequestNotificationPermission as (...a: unknown[]) => unknown)(...args),
    },
  },
}));

import { Platform } from 'react-native';

import {
  areAndroidAlarmPermissionsGranted,
  cancelAndroidAlarm,
  computeScheduleAlarmTriggerMillis,
  getAndroidAlarmPermissionStatus,
  isAndroidAlarmSupported,
  openAndroidAlarmPermissionSettings,
  requestAndroidNotificationPermission,
  scheduleAndroidAlarm,
} from '@/features/reminder/native/alarmScheduler';

describe('alarmScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'android';
    mockSchedule.mockResolvedValue({ alarmId: 'alarm_1' });
    mockCancel.mockResolvedValue(true);
    mockGetPermissionStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: true,
      fullScreen: true,
      notifications: true,
      battery: true,
    });
  });

  describe('computeScheduleAlarmTriggerMillis', () => {
    it('returns null without a start time or with an invalid one', () => {
      expect(computeScheduleAlarmTriggerMillis(null, 0)).toBeNull();
      expect(computeScheduleAlarmTriggerMillis('not-a-date', 0)).toBeNull();
    });

    it('returns null when the trigger is not in the future', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      expect(computeScheduleAlarmTriggerMillis(past, 0)).toBeNull();
    });

    it('subtracts the offset from start_time', () => {
      const start = Date.now() + 30 * 60_000;
      const trigger = computeScheduleAlarmTriggerMillis(new Date(start).toISOString(), 10);
      expect(trigger).toBe(start - 10 * 60_000);
    });

    it('defaults a missing offset to zero', () => {
      const start = Date.now() + 60_000;
      expect(computeScheduleAlarmTriggerMillis(new Date(start).toISOString(), null)).toBe(start);
    });
  });

  describe('native wrappers on android', () => {
    it('reports support when the native module exists', () => {
      expect(isAndroidAlarmSupported()).toBe(true);
    });

    it('schedules and returns the alarm id', async () => {
      await expect(scheduleAndroidAlarm(Date.now() + 60_000, '会议')).resolves.toBe('alarm_1');
      expect(mockSchedule).toHaveBeenCalled();
    });

    it('cancels by id and swallows cancel errors', async () => {
      await cancelAndroidAlarm('alarm_1');
      expect(mockCancel).toHaveBeenCalledWith('alarm_1');
      mockCancel.mockRejectedValueOnce(new Error('gone'));
      await expect(cancelAndroidAlarm('alarm_1')).resolves.toBeUndefined();
      await expect(cancelAndroidAlarm(null)).resolves.toBeUndefined();
    });

    it('reads permission status and opens settings', async () => {
      await expect(getAndroidAlarmPermissionStatus()).resolves.toMatchObject({ exactAlarm: true });
      await openAndroidAlarmPermissionSettings('exactAlarm');
      expect(mockOpenPermissionSettings).toHaveBeenCalledWith('exactAlarm');
      await expect(requestAndroidNotificationPermission()).resolves.toBe(true);
      await expect(areAndroidAlarmPermissionsGranted()).resolves.toBe(true);
    });

    it('rejects areAndroidAlarmPermissionsGranted when any flag is false', async () => {
      mockGetPermissionStatus.mockResolvedValueOnce({
        exactAlarm: true,
        overlay: true,
        fullScreen: true,
        notifications: false,
        battery: true,
      });
      await expect(areAndroidAlarmPermissionsGranted()).resolves.toBe(false);
    });
  });

  describe('unsupported platforms', () => {
    it('short-circuits when not android', async () => {
      (Platform as { OS: string }).OS = 'ios';
      expect(isAndroidAlarmSupported()).toBe(false);
      await expect(scheduleAndroidAlarm(1, 't')).resolves.toBeNull();
      await expect(getAndroidAlarmPermissionStatus()).resolves.toBeNull();
      await expect(requestAndroidNotificationPermission()).resolves.toBe(false);
      await expect(areAndroidAlarmPermissionsGranted()).resolves.toBe(false);
      await openAndroidAlarmPermissionSettings('app');
      await cancelAndroidAlarm('x');
    });
  });
});
