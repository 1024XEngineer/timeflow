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
    GUARD_NOTIFICATION_TITLE: actual.GUARD_NOTIFICATION_TITLE,
    subscribeGuardTaskEvents: jest.fn(() => () => {}),
    resolveNextPollIntervalMs: actual.resolveNextPollIntervalMs,
  };
});

const getForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
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

// 写死的历史日期迟早会滑到"过去"，让依赖它的用例悄悄失效——改成相对当前
// 时间的未来偏移量，不管什么时候跑这条用例都成立。
const FUTURE_TRIGGER_ISO = new Date(Date.now() + 60 * 60_000).toISOString();

function timeSchedule(overrides: Partial<LocalReminderSchedule> = {}): LocalReminderSchedule {
  return {
    id: 't1',
    account_id: 'a1',
    title: '晨会',
    schedule_type: 'time',
    schedule_kind: 'once',
    is_all_day: false,
    start_time: FUTURE_TRIGGER_ISO,
    end_time: null,
    timezone: 'UTC',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 0,
    reminder: {
      reminder_type: 'at_time',
      reminder_trigger_at: FUTURE_TRIGGER_ISO,
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
    startUpdates.mockResolvedValue(undefined);
    stopUpdates.mockResolvedValue(undefined);
    // 默认"还没启动"——ensureLocationUpdates 现在也会查这个真实状态来判断
    // 要不要重新调 startLocationUpdatesAsync，跟 stopLocationUpdates 共用同一个
    // mock；哪个测试要验证"已经在跑"分支（比如停止逻辑），在 start() 成功之后
    // 自己把它改成 true。
    hasStarted.mockResolvedValue(false);
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
    expect(options?.foregroundService?.notificationBody).toBe('提醒守护运行中');
  });

  it('does not start when foreground location permission is missing', async () => {
    getForeground.mockResolvedValue({
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

  it('starts the time-only fallback with just foreground permission (no background permission needed)', async () => {
    // startLocationUpdatesAsync() 走的是 foregroundService 配置这条路径，原生侧本身
    // 就不要求 ACCESS_BACKGROUND_LOCATION——用户只给了"仅使用时允许"也应该照样启动，
    // 不然纯时间型日程的兜底轮询会被一个跟它无关的权限卡死。
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).toHaveBeenCalledTimes(1);
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
    hasStarted.mockResolvedValue(true);

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
    hasStarted.mockResolvedValue(true);

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
