import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';

import type { LocalReminderSchedule } from '../../../../../src/features/reminder/domain';
import { ReminderGuardCoordinator } from '../../../../../src/features/reminder/application/ReminderGuardCoordinator';
import {
  GUARD_TASK_NAME,
  subscribeGuardTaskEvents,
} from '../../../../../src/infrastructure/location/reminderGuardTask';

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
}));

jest.mock('../../../../../src/infrastructure/location/reminderGuardTask', () => {
  const actual = jest.requireActual<
    typeof import('../../../../../src/infrastructure/location/reminderGuardTask')
  >('../../../../../src/infrastructure/location/reminderGuardTask');
  return {
    GUARD_TASK_NAME: 'timeflow-reminder-guard',
    subscribeGuardTaskEvents: jest.fn(() => () => {}),
    resolveNextPollIntervalMs: actual.resolveNextPollIntervalMs,
  };
});

const getForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
>;
const getBackground = Location.getBackgroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getBackgroundPermissionsAsync
>;
const startUpdates = Location.startLocationUpdatesAsync as jest.MockedFunction<
  typeof Location.startLocationUpdatesAsync
>;
const stopUpdates = Location.stopLocationUpdatesAsync as jest.MockedFunction<
  typeof Location.stopLocationUpdatesAsync
>;
const hasStarted = Location.hasStartedLocationUpdatesAsync as jest.MockedFunction<
  typeof Location.hasStartedLocationUpdatesAsync
>;
const subscribeTaskEvents = subscribeGuardTaskEvents as jest.MockedFunction<
  typeof subscribeGuardTaskEvents
>;

function granted(): Location.PermissionResponse {
  return {
    status: 'granted' as Location.PermissionStatus,
    granted: true,
    canAskAgain: true,
    expires: 'never',
  };
}

function timeSchedule(overrides: Partial<LocalReminderSchedule> = {}): LocalReminderSchedule {
  return {
    id: 't1',
    account_id: 'a1',
    title: '晨会',
    schedule_type: 'time',
    schedule_kind: 'once',
    is_all_day: false,
    start_time: '2026-08-18T10:00:00.000Z',
    end_time: null,
    timezone: 'UTC',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 0,
    reminder: {
      reminder_type: 'at_time',
      reminder_trigger_at: '2026-08-18T10:00:00.000Z',
      reminder_offset_minutes: null,
      reminder_strength: 'medium',
    },
    runtime: {
      reminder_disposition_state: null,
      next_trigger_at: null,
      snoozed_until: null,
      geofence_armed: false,
      disposition_updated_at: null,
      sync_status: 'synced',
      recorded_location: null,
    },
    status: 'active',
    revision: 1,
    cloud_revision: 1,
    updated_at: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

function locationSchedule(overrides: Partial<LocalReminderSchedule> = {}): LocalReminderSchedule {
  return {
    ...timeSchedule(),
    id: 'l1',
    schedule_type: 'location',
    start_time: null,
    latitude: 31.2304,
    longitude: 121.4737,
    geofence_radius_meters: 200,
    reminder: {
      reminder_type: 'arrive_location',
      reminder_trigger_at: null,
      reminder_offset_minutes: null,
      reminder_strength: 'medium',
    },
    ...overrides,
  };
}

function createReader(schedules: LocalReminderSchedule[]) {
  const listeners = new Set<(schedules: readonly LocalReminderSchedule[]) => void>();
  return {
    listReminderSchedules: jest.fn(async () => schedules),
    getReminderSchedule: jest.fn(async (id: string) => schedules.find((s) => s.id === id) ?? null),
    subscribe: jest.fn((listener: (schedules: readonly LocalReminderSchedule[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit: () => {
      for (const listener of listeners) listener(schedules);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe('ReminderGuardCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getForeground.mockResolvedValue(granted());
    getBackground.mockResolvedValue(granted());
    startUpdates.mockResolvedValue(undefined);
    stopUpdates.mockResolvedValue(undefined);
    hasStarted.mockResolvedValue(true);
    subscribeTaskEvents.mockReturnValue(() => {});
  });

  it('does not start location updates when there is nothing active to watch', async () => {
    const reader = createReader([]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('starts location updates at the sparsest interval for a time-only backlog', async () => {
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).toHaveBeenCalledTimes(1);
    const [taskName, options] = startUpdates.mock.calls[0];
    expect(taskName).toBe(GUARD_TASK_NAME);
    expect(options?.timeInterval).toBe(300_000);
    expect(options?.foregroundService?.notificationBody).toContain('晨会');
  });

  it('mentions the location backlog count alongside the next time-type countdown', async () => {
    const reader = createReader([timeSchedule(), locationSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    const [, options] = startUpdates.mock.calls[0];
    expect(options?.foregroundService?.notificationBody).toContain('晨会');
    expect(options?.foregroundService?.notificationBody).toContain('1 个地点提醒');
  });

  it('does not start when foreground or background location permission is missing', async () => {
    getBackground.mockResolvedValue({
      status: 'denied' as Location.PermissionStatus,
      granted: false,
      canAskAgain: true,
      expires: 'never',
    });
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('stops location updates once every schedule is confirmed or removed', async () => {
    const schedule = timeSchedule();
    const reader = createReader([schedule]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    await coordinator.start();
    expect(startUpdates).toHaveBeenCalledTimes(1);

    schedule.runtime = { ...schedule.runtime, reminder_disposition_state: 'confirmed' };
    reader.emit();
    await flushMicrotasks();

    expect(stopUpdates).toHaveBeenCalledWith(GUARD_TASK_NAME);
  });

  it('stop() tears down the subscription and stops location updates', async () => {
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    await coordinator.start();

    await coordinator.stop();

    expect(stopUpdates).toHaveBeenCalledWith(GUARD_TASK_NAME);
  });

  it('routes an incoming guard sample to handleLocation and re-reconciles', async () => {
    let sampleListener:
      | ((sample: {
          latitude: number;
          longitude: number;
          accuracy_meters: number;
          observed_at: string;
        }) => void)
      | undefined;
    subscribeTaskEvents.mockImplementation((listener) => {
      sampleListener = listener as typeof sampleListener;
      return () => {};
    });
    const handleLocation = jest.fn(async () => {});
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({ schedules: reader, handleLocation });
    await coordinator.start();
    startUpdates.mockClear();

    await sampleListener?.({
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy_meters: 10,
      observed_at: '2026-08-18T10:00:00.000Z',
    });

    expect(handleLocation).toHaveBeenCalledTimes(1);
  });
});
