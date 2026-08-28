import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules, Platform } from 'react-native';

import type { AlarmScheduleRequest } from '../../../../src/features/reminder/application/interfaces';
import { NativeAlarmScheduler } from '../../../../src/infrastructure/notifications/NativeAlarmScheduler';
import {
  isTimeflowAlarmAvailable,
  nativeAckAlarmDispositions,
  nativeAckFireAttempts,
  nativeAreAlarmPermissionsGranted,
  nativeCancelAlarm,
  nativeCancelAllAlarms,
  nativeGetAlarmPermissionStatus,
  nativeHasArmedAlarm,
  nativeOpenAlarmPermissionSettings,
  nativePeekAlarmDispositions,
  nativePeekFireAttempts,
  nativePresentAlarmNow,
  nativeRequestNotificationPermission,
  nativeScheduleAlarm,
  nativeStopAlarmRinging,
  subscribeNativeAlarmEvents,
} from '../../../../src/infrastructure/notifications/native/TimeflowAlarmBridge';

const mockListeners = new Map<string, Set<(payload: unknown) => void>>();

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native') as typeof import('react-native');
  RN.NativeModules.TimeflowAlarm = {
    schedule: jest.fn(),
    cancel: jest.fn(),
    cancelAll: jest.fn(),
    stopRinging: jest.fn(),
    presentNow: jest.fn(),
    hasArmedAlarm: jest.fn(),
    peekNativeDispositions: jest.fn(),
    ackNativeDispositions: jest.fn(),
    peekNativeFireAttempts: jest.fn(),
    ackNativeFireAttempts: jest.fn(),
    getPermissionStatus: jest.fn(),
    openPermissionSettings: jest.fn(),
    requestNotificationPermission: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  class FakeNativeEventEmitter {
    addListener(eventName: string, listener: (payload: unknown) => void) {
      const set = mockListeners.get(eventName) ?? new Set();
      set.add(listener);
      mockListeners.set(eventName, set);
      return { remove: () => set.delete(listener) };
    }
  }
  Object.defineProperty(RN, 'NativeEventEmitter', {
    value: FakeNativeEventEmitter,
    configurable: true,
  });
  return RN;
});

function emit(eventName: string, payload: unknown): void {
  for (const listener of mockListeners.get(eventName) ?? []) {
    listener(payload);
  }
}

type NativeAlarmMock = {
  schedule: jest.MockedFunction<
    (
      triggerAtMillis: number,
      title?: string | null,
      scheduleId?: string | null,
      vibrate?: boolean,
      soundTier?: string,
      fullScreen?: boolean,
      speechText?: string | null,
    ) => Promise<{ alarmId: string }>
  >;
  cancel: jest.MockedFunction<(alarmId: string) => Promise<boolean>>;
  cancelAll: jest.MockedFunction<() => Promise<number>>;
  stopRinging: jest.MockedFunction<() => Promise<boolean>>;
  presentNow: jest.MockedFunction<
    (
      alarmId: string,
      scheduleId: string,
      title: string,
      vibrate: boolean,
      soundTier: string,
      fullScreen: boolean,
    ) => Promise<boolean>
  >;
  hasArmedAlarm: jest.MockedFunction<(scheduleId: string) => Promise<boolean>>;
  peekNativeDispositions: jest.MockedFunction<
    () => Promise<{ scheduleId: string; alarmId: string; state: string; updatedAtMillis: number }[]>
  >;
  ackNativeDispositions: jest.MockedFunction<(scheduleIds: string[]) => Promise<boolean>>;
  peekNativeFireAttempts: jest.MockedFunction<
    () => Promise<{ result: string; atMillis: number }[]>
  >;
  ackNativeFireAttempts: jest.MockedFunction<() => Promise<boolean>>;
  getPermissionStatus: jest.MockedFunction<
    () => Promise<{
      exactAlarm: boolean;
      overlay: boolean;
      fullScreen: boolean;
      notifications: boolean;
      battery: boolean;
    }>
  >;
  openPermissionSettings: jest.MockedFunction<(kind: string) => Promise<boolean>>;
  requestNotificationPermission: jest.MockedFunction<() => Promise<boolean>>;
};

const NOW = '2026-08-13T08:00:00.000Z';
const FUTURE = '2026-08-13T09:00:00.000Z';
const PAST = '2026-08-13T07:00:00.000Z';

const native = NativeModules.TimeflowAlarm as unknown as NativeAlarmMock;

function request(overrides: Partial<AlarmScheduleRequest> = {}): AlarmScheduleRequest {
  return {
    schedule_id: 'schedule-1',
    trigger_at: FUTURE,
    title: '晨会',
    exact: true,
    vibrate: true,
    sound_tier: 'full',
    full_screen: true,
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
    mockListeners.clear();
    native.schedule.mockReset();
    native.cancel.mockReset();
    native.cancelAll.mockReset();
    native.stopRinging.mockReset();
    native.presentNow.mockReset();
    native.hasArmedAlarm.mockReset();
    native.peekNativeDispositions.mockReset();
    native.ackNativeDispositions.mockReset();
    native.getPermissionStatus.mockReset();
    native.openPermissionSettings.mockReset();
    native.requestNotificationPermission.mockReset();
    grantPermissions();
    native.schedule.mockResolvedValue({ alarmId: 'alarm-1' });
    native.cancel.mockResolvedValue(true);
    native.cancelAll.mockResolvedValue(0);
    native.stopRinging.mockResolvedValue(true);
    native.presentNow.mockResolvedValue(true);
    native.hasArmedAlarm.mockResolvedValue(false);
    native.peekNativeDispositions.mockResolvedValue([]);
    native.ackNativeDispositions.mockResolvedValue(true);
    native.openPermissionSettings.mockResolvedValue(true);
    native.requestNotificationPermission.mockResolvedValue(true);
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
    expect(native.schedule).toHaveBeenCalledWith(
      Date.parse(FUTURE),
      '晨会',
      'schedule-1',
      true,
      'full',
      true,
      '',
    );
  });

  it('forwards vibrate/sound_tier/full_screen through to the native bridge', async () => {
    const scheduler = new NativeAlarmScheduler();
    await scheduler.schedule(request({ vibrate: false, sound_tier: 'none', full_screen: false }));
    expect(native.schedule).toHaveBeenCalledWith(
      Date.parse(FUTURE),
      '晨会',
      'schedule-1',
      false,
      'none',
      false,
      '',
    );
  });

  it('forwards speech_text to the native bridge', async () => {
    const scheduler = new NativeAlarmScheduler();
    await scheduler.schedule(request({ speech_text: '九点面试' }));
    expect(native.schedule).toHaveBeenCalledWith(
      Date.parse(FUTURE),
      '晨会',
      'schedule-1',
      true,
      'full',
      true,
      '九点面试',
    );
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
    await expect(nativeGetAlarmPermissionStatus()).resolves.toBeNull();
  });

  it('forwards cancel true and false from the native module', async () => {
    const scheduler = new NativeAlarmScheduler();
    native.cancel.mockResolvedValueOnce(true);
    await expect(scheduler.cancel('alarm-1')).resolves.toEqual({ cancelled: true });
    native.cancel.mockResolvedValueOnce(false);
    await expect(scheduler.cancel('alarm-1')).resolves.toEqual({ cancelled: false });
    expect(native.cancel).toHaveBeenCalledTimes(2);
  });

  it('returns cancelled: false when cancel is called with an empty id', async () => {
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.cancel(null)).resolves.toEqual({ cancelled: false });
    await expect(scheduler.cancel('')).resolves.toEqual({ cancelled: false });
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it('maps a native cancel rejection to cancelled: false, not a false claim of success', async () => {
    native.cancel.mockRejectedValue(new Error('cancel failed'));
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.cancel('alarm-1')).resolves.toEqual({ cancelled: false });
    await expect(nativeCancelAlarm('alarm-1')).resolves.toBe(false);
  });

  it('nativeCancelAlarm is a no-op returning false when the bridge is unavailable or the id is empty', async () => {
    Platform.OS = 'ios';
    await expect(nativeCancelAlarm('alarm-1')).resolves.toBe(false);
    Platform.OS = 'android';
    await expect(nativeCancelAlarm(null)).resolves.toBe(false);
    await expect(nativeCancelAlarm(undefined)).resolves.toBe(false);
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it('rebuilds mixed requests in order and cancels all native alarms first', async () => {
    native.schedule.mockResolvedValueOnce({ alarmId: 'alarm-ok' }).mockResolvedValueOnce({
      alarmId: 'alarm-later',
    });
    const scheduler = new NativeAlarmScheduler();
    const receipts = await scheduler.rebuild([
      request({ schedule_id: 'ok' }),
      request({ schedule_id: 'expired', trigger_at: PAST }),
      request({ schedule_id: 'later', trigger_at: '2026-08-13T10:00:00.000Z', title: '午会' }),
    ]);
    expect(receipts).toEqual([
      { alarm_id: 'alarm-ok', schedule_id: 'ok', scheduled: true },
      { alarm_id: '', schedule_id: 'expired', scheduled: false },
      { alarm_id: 'alarm-later', schedule_id: 'later', scheduled: true },
    ]);
    expect(native.cancelAll).toHaveBeenCalledTimes(1);
    expect(native.schedule).toHaveBeenCalledTimes(2);
    expect(native.schedule).toHaveBeenNthCalledWith(
      1,
      Date.parse(FUTURE),
      '晨会',
      'ok',
      true,
      'full',
      true,
      '',
    );
    expect(native.schedule).toHaveBeenNthCalledWith(
      2,
      Date.parse('2026-08-13T10:00:00.000Z'),
      '午会',
      'later',
      true,
      'full',
      true,
      '',
    );
  });

  it('nativeCancelAllAlarms swallows a native rejection', async () => {
    native.cancelAll.mockRejectedValue(new Error('cancelAll failed'));
    await expect(nativeCancelAllAlarms()).resolves.toBeUndefined();
  });

  it('stopRinging calls the native bridge and swallows rejection', async () => {
    const scheduler = new NativeAlarmScheduler();
    await scheduler.stopRinging();
    expect(native.stopRinging).toHaveBeenCalledTimes(1);

    native.stopRinging.mockRejectedValue(new Error('stop failed'));
    await expect(nativeStopAlarmRinging()).resolves.toBeUndefined();
  });

  it('presentNow forwards to the native bridge and returns the receipt', async () => {
    const scheduler = new NativeAlarmScheduler();
    await expect(
      scheduler.presentNow({
        alarm_id: 'alarm-9',
        schedule_id: 'schedule-1',
        title: '晨会',
        vibrate: true,
        sound_tier: 'full',
        full_screen: true,
      }),
    ).resolves.toEqual({ alarm_id: 'alarm-9', schedule_id: 'schedule-1', presented: true });
    expect(native.presentNow).toHaveBeenCalledWith(
      'alarm-9',
      'schedule-1',
      '晨会',
      true,
      'full',
      true,
      '',
    );
  });

  it('presentNow generates a guard-ids alarm id when none is provided', async () => {
    const scheduler = new NativeAlarmScheduler();
    const receipt = await scheduler.presentNow({
      alarm_id: '',
      schedule_id: 'schedule-1',
      title: '晨会',
      vibrate: false,
      sound_tier: 'ping',
      full_screen: true,
    });
    expect(receipt.alarm_id).toMatch(/^geofence-schedule-1-\d+$/);
    expect(native.presentNow).toHaveBeenCalledWith(
      receipt.alarm_id,
      'schedule-1',
      '晨会',
      false,
      'ping',
      true,
      '',
    );
  });

  it('nativePresentAlarmNow returns true on the happy path and false when declined', async () => {
    await expect(
      nativePresentAlarmNow('alarm-1', 'schedule-1', '晨会', true, 'full', true),
    ).resolves.toBe(true);

    native.presentNow.mockResolvedValue(false);
    await expect(
      nativePresentAlarmNow('alarm-1', 'schedule-1', '晨会', true, 'full', true),
    ).resolves.toBe(false);
  });

  it('nativePresentAlarmNow fails closed off Android and on native rejection', async () => {
    Platform.OS = 'ios';
    await expect(
      nativePresentAlarmNow('alarm-1', 'schedule-1', '晨会', true, 'full', true),
    ).resolves.toBe(false);
    Platform.OS = 'android';

    native.presentNow.mockRejectedValue(new Error('present failed'));
    await expect(
      nativePresentAlarmNow('alarm-1', 'schedule-1', '晨会', true, 'full', true),
    ).resolves.toBe(false);
  });

  it('nativeHasArmedAlarm forwards the native query and falls back to false', async () => {
    native.hasArmedAlarm.mockResolvedValue(true);
    await expect(nativeHasArmedAlarm('schedule-1')).resolves.toBe(true);
    expect(native.hasArmedAlarm).toHaveBeenCalledWith('schedule-1');

    native.hasArmedAlarm.mockResolvedValue(false);
    await expect(nativeHasArmedAlarm('schedule-1')).resolves.toBe(false);
  });

  it('nativeHasArmedAlarm fails closed off Android, with an empty id, and on rejection', async () => {
    Platform.OS = 'ios';
    await expect(nativeHasArmedAlarm('schedule-1')).resolves.toBe(false);
    Platform.OS = 'android';
    await expect(nativeHasArmedAlarm('')).resolves.toBe(false);

    native.hasArmedAlarm.mockRejectedValue(new Error('query failed'));
    await expect(nativeHasArmedAlarm('schedule-1')).resolves.toBe(false);
  });

  it('peeks native dispositions and maps known states, dropping unknown ones', async () => {
    native.peekNativeDispositions.mockResolvedValue([
      { scheduleId: 'a', alarmId: 'alarm-a', state: 'confirmed', updatedAtMillis: 1000 },
      { scheduleId: 'b', alarmId: 'alarm-b', state: 'pending', updatedAtMillis: 2000 },
      { scheduleId: 'c', alarmId: 'alarm-c', state: 'snoozed', updatedAtMillis: 3000 },
      { scheduleId: 'd', alarmId: 'alarm-d', state: 'unknown-state', updatedAtMillis: 4000 },
      { scheduleId: '', alarmId: 'alarm-e', state: 'confirmed', updatedAtMillis: 5000 },
    ]);
    const scheduler = new NativeAlarmScheduler();
    const rows = await scheduler.peekNativeDispositions();
    expect(rows).toEqual([
      {
        schedule_id: 'a',
        alarm_id: 'alarm-a',
        state: 'confirmed',
        updated_at: new Date(1000).toISOString(),
      },
      {
        schedule_id: 'b',
        alarm_id: 'alarm-b',
        state: 'pending',
        updated_at: new Date(2000).toISOString(),
      },
      {
        schedule_id: 'c',
        alarm_id: 'alarm-c',
        state: 'snoozed',
        updated_at: new Date(3000).toISOString(),
      },
    ]);
  });

  it('peekNativeDispositions returns an empty list when the bridge is unavailable or rejects', async () => {
    Platform.OS = 'ios';
    await expect(nativePeekAlarmDispositions()).resolves.toEqual([]);
    Platform.OS = 'android';
    native.peekNativeDispositions.mockRejectedValue(new Error('peek failed'));
    await expect(nativePeekAlarmDispositions()).resolves.toEqual([]);
  });

  it('acknowledges native dispositions by schedule id', async () => {
    const scheduler = new NativeAlarmScheduler();
    await scheduler.ackNativeDispositions(['a', 'b']);
    expect(native.ackNativeDispositions).toHaveBeenCalledWith(['a', 'b']);
  });

  it('peeks and acks native background fire attempts without schedule ids', async () => {
    native.peekNativeFireAttempts.mockResolvedValue([
      { result: 'service_denied', atMillis: 1000 },
      { result: 'present_failed', atMillis: 2000 },
      { result: 'unknown', atMillis: 3000 },
    ]);
    const scheduler = new NativeAlarmScheduler();
    await expect(scheduler.peekNativeFireAttempts()).resolves.toEqual([
      { result: 'service_denied', at: new Date(1000).toISOString() },
      { result: 'present_failed', at: new Date(2000).toISOString() },
    ]);
    await scheduler.ackNativeFireAttempts();
    expect(native.ackNativeFireAttempts).toHaveBeenCalled();
  });

  it('nativePeekFireAttempts and nativeAckFireAttempts swallow native rejection', async () => {
    native.peekNativeFireAttempts.mockRejectedValue(new Error('peek failed'));
    await expect(nativePeekFireAttempts()).resolves.toEqual([]);

    native.ackNativeFireAttempts.mockRejectedValue(new Error('ack failed'));
    await expect(nativeAckFireAttempts()).resolves.toBeUndefined();
  });

  it('nativeAckAlarmDispositions is a no-op with an empty list and swallows rejection', async () => {
    await nativeAckAlarmDispositions([]);
    expect(native.ackNativeDispositions).not.toHaveBeenCalled();

    native.ackNativeDispositions.mockRejectedValue(new Error('ack failed'));
    await expect(nativeAckAlarmDispositions(['a'])).resolves.toBeUndefined();
  });

  it('subscribes to native fired/dismissed/snoozed events and ignores unknown types', () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeNativeAlarmEvents((event) => received.push(event));

    emit('TimeflowAlarmEvent', {
      type: 'fired',
      scheduleId: 'a',
      alarmId: 'alarm-a',
      title: '晨会',
      atMillis: 1000,
    });
    emit('TimeflowAlarmEvent', { type: 'unknown', scheduleId: 'b' });

    expect(received).toEqual([
      {
        type: 'fired',
        scheduleId: 'a',
        alarmId: 'alarm-a',
        title: '晨会',
        atMillis: 1000,
      },
    ]);

    unsubscribe();
  });

  it('NativeAlarmScheduler.subscribe maps native event payloads to the port shape', () => {
    const scheduler = new NativeAlarmScheduler();
    const received: unknown[] = [];
    const unsubscribe = scheduler.subscribe((event) => received.push(event));

    emit('TimeflowAlarmEvent', {
      type: 'dismissed',
      scheduleId: 'a',
      alarmId: 'alarm-a',
      title: '晨会',
      atMillis: 1000,
    });

    expect(received).toEqual([
      {
        type: 'dismissed',
        schedule_id: 'a',
        alarm_id: 'alarm-a',
        title: '晨会',
        at: new Date(1000).toISOString(),
      },
    ]);

    unsubscribe();
  });

  it('subscribe falls back to a no-op unsubscribe when the bridge is unavailable', () => {
    Platform.OS = 'ios';
    const unsubscribe = subscribeNativeAlarmEvents(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('requests permission settings and notification permission through the bridge', async () => {
    await expect(nativeOpenAlarmPermissionSettings('exactAlarm')).resolves.toBe(true);
    expect(native.openPermissionSettings).toHaveBeenCalledWith('exactAlarm');

    await expect(nativeRequestNotificationPermission()).resolves.toBe(true);
    expect(native.requestNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it('permission-settings and notification-permission calls fail closed off Android', async () => {
    Platform.OS = 'ios';
    await expect(nativeOpenAlarmPermissionSettings('app')).resolves.toBe(false);
    await expect(nativeRequestNotificationPermission()).resolves.toBe(false);
  });

  it('permission-settings and notification-permission calls fail closed on rejection', async () => {
    native.openPermissionSettings.mockRejectedValue(new Error('settings failed'));
    native.requestNotificationPermission.mockRejectedValue(new Error('permission failed'));
    await expect(nativeOpenAlarmPermissionSettings('app')).resolves.toBe(false);
    await expect(nativeRequestNotificationPermission()).resolves.toBe(false);
  });
});
