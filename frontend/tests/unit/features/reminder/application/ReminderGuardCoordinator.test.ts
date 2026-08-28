import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';

import * as TaskManager from 'expo-task-manager';

import type { LocalReminderSchedule } from '../../../../../src/features/reminder/domain';
import { ReminderGuardCoordinator } from '../../../../../src/features/reminder/application/ReminderGuardCoordinator';
import {
  GUARD_TASK_NAME,
  isAppForegrounded,
  subscribeGuardTaskEvents,
} from '../../../../../src/infrastructure/location/reminderGuardTask';

jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  getForegroundPermissionsAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
}));

// isTaskDefined/defineTask 是给下面那份 requireActual 的 reminderGuardTask 用的
// ——它在模块顶层就会调 isTaskDefined 来决定要不要 defineTask，只 mock
// getRegisteredTasksAsync 的话整个 suite 在加载阶段就挂了。
jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(() => true),
  defineTask: jest.fn(),
  getRegisteredTasksAsync: jest.fn(),
  isTaskRegisteredAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock('../../../../../src/infrastructure/location/reminderGuardTask', () => {
  const actual = jest.requireActual<
    typeof import('../../../../../src/infrastructure/location/reminderGuardTask')
  >('../../../../../src/infrastructure/location/reminderGuardTask');
  return {
    GUARD_TASK_NAME: 'timeflow-reminder-guard',
    GUARD_NOTIFICATION_TITLE: actual.GUARD_NOTIFICATION_TITLE,
    GUARD_NOTIFICATION_BODY: actual.GUARD_NOTIFICATION_BODY,
    isAppForegrounded: jest.fn(() => true),
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
const getRegisteredTasks = TaskManager.getRegisteredTasksAsync as jest.MockedFunction<
  typeof TaskManager.getRegisteredTasksAsync
>;
const isTaskRegistered = TaskManager.isTaskRegisteredAsync as jest.MockedFunction<
  typeof TaskManager.isTaskRegisteredAsync
>;
const unregisterTask = TaskManager.unregisterTaskAsync as jest.MockedFunction<
  typeof TaskManager.unregisterTaskAsync
>;
const foregrounded = isAppForegrounded as jest.MockedFunction<typeof isAppForegrounded>;

/**
 * 造一条原生注册项。`withForegroundService` 就是这组用例的全部分水岭：带着它
 * 代表常驻前台服务还活着，不带代表服务已经被原生拆掉、只剩一个纯后台定位任务
 * ——而 hasStartedLocationUpdatesAsync() 对这两种情况的回答一模一样。
 */
function registeredTask(withForegroundService: boolean): TaskManager.TaskManagerTask {
  return {
    taskName: GUARD_TASK_NAME,
    taskType: 'location',
    options: {
      accuracy: 3,
      timeInterval: 300_000,
      ...(withForegroundService
        ? { foregroundService: { notificationTitle: 'Timeflow 提醒守护' } }
        : {}),
    },
  };
}

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

function locationSchedule(overrides: Partial<LocalReminderSchedule> = {}): LocalReminderSchedule {
  return timeSchedule({
    schedule_type: 'location',
    latitude: 31.2304,
    longitude: 121.4737,
    location_name: '工地',
    reminder: {
      reminder_type: 'arrive_location',
      reminder_trigger_at: null,
      reminder_offset_minutes: null,
      reminder_strength: 'medium',
    },
    ...overrides,
  });
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
    isTaskRegistered.mockResolvedValue(true);
    unregisterTask.mockResolvedValue(undefined);
    // 默认"还没启动"——ensureLocationUpdates 现在也会查这个真实状态来判断
    // 要不要重新调 startLocationUpdatesAsync，跟 stopLocationUpdates 共用同一个
    // mock；哪个测试要验证"已经在跑"分支（比如停止逻辑），在 start() 成功之后
    // 自己把它改成 true。
    hasStarted.mockResolvedValue(false);
    subscribeTaskEvents.mockReturnValue(() => {});
    // 默认"注册着而且带前台服务"——只有把 hasStarted 也改成 true 时这份返回值
    // 才会被读到，所以对上面那批 hasStarted=false 的用例没有影响。
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    foregrounded.mockReturnValue(true);
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

  it('stop() returns if location teardown never settles', async () => {
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    await coordinator.start();
    hasStarted.mockReturnValue(new Promise(() => undefined));

    jest.useFakeTimers();
    try {
      const stopping = coordinator.stop();
      jest.advanceTimersByTime(2_000);
      await stopping;
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not restart location updates after a timed-out stop() while reconcile awaits registration state', async () => {
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    await coordinator.start();
    expect(startUpdates).toHaveBeenCalledTimes(1);
    startUpdates.mockClear();

    const pendingHasStarted: Array<(value: boolean) => void> = [];
    hasStarted.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          pendingHasStarted.push(resolve);
        }),
    );

    reader.emit();
    await flushMicrotasks();

    jest.useFakeTimers();
    try {
      const stopping = coordinator.stop();
      jest.advanceTimersByTime(2_000);
      await stopping;
    } finally {
      jest.useRealTimers();
    }

    for (const resolve of pendingHasStarted) resolve(false);
    await flushMicrotasks();

    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('force-stops a location start that completed after logout', async () => {
    let finishStart: () => void = () => {};
    startUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = () => resolve();
        }),
    );

    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    const starting = coordinator.start();
    await flushMicrotasks();

    await coordinator.stop();

    hasStarted.mockResolvedValue(true);
    finishStart();
    await starting;

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

  it('watches location schedules and resolves their geofence centers', async () => {
    // 有地点型日程时，reconcile 会把围栏中心解析出来（lastSample 为 null 时落在最疏档），
    // 这个"地点目标"分支此前没有用例覆盖。
    const reader = createReader([locationSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).toHaveBeenCalledTimes(1);
    const [, options] = startUpdates.mock.calls[0];
    expect(options?.timeInterval).toBe(300_000);
  });

  it('rebuilds a registration inherited from a previous process even when it carries the foreground service', async () => {
    // force-stop 杀不掉 expo-task-manager 持久化的注册记录：冷启动读到的
    // 'foreground' 可能是上一个进程留下的，注册还在、投递已经随进程一起死了。
    // 改之前协调器信了它直接早退，守护就此永久停摆，只有重装能恢复。
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(stopUpdates).toHaveBeenCalledWith(GUARD_TASK_NAME);
    expect(startUpdates).toHaveBeenCalledTimes(1);
  });

  it('still rebuilds an inherited registration when its dying heartbeats land first', async () => {
    // 真机实测：force-stop 之后重开，继承来的注册会先投出一两次心跳（上一份注册
    // 的余波，两条样本紧挨着 13ms），之后彻底停摆。只按"最近有没有心跳"判断的话
    // 会被这两下骗过去，当它还活着而不去重建，守护就此又卡死。
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
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await sampleListener?.({
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy_meters: 10,
      observed_at: '2026-08-18T10:00:00.000Z',
    });
    await coordinator.start();

    expect(stopUpdates).toHaveBeenCalledWith(GUARD_TASK_NAME);
    expect(startUpdates).toHaveBeenCalledTimes(1);
  });

  it('unregisters the task itself before rebuilding, not just the location updates', async () => {
    // 真机实测：进程被杀之后光 stopLocationUpdatesAsync 再 start，注册看着建上了
    // （hasStarted=true、options 带着 foregroundService、间隔也对）却一次样本都不
    // 投递，只有卸载重装能恢复——因为 TaskManager 里那条持久化的任务注册没被清掉。
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(unregisterTask).toHaveBeenCalledWith(GUARD_TASK_NAME);
    expect(startUpdates).toHaveBeenCalledTimes(1);
  });

  it('aborts the rebuild when unregistering the stale task fails, instead of re-registering anyway', async () => {
    // 持久化记录没被真正删掉的话，重注册走的还是原生"已存在就 setOptions"那条
    // 分支——等于又绑上了同一条失活的记录，下次 reconcile 读到的 state 还是
    // 'foreground'，会被当成健康注册直接早退，恢复彻底失败且没有任何痕迹。
    // 所以注销失败必须整段放弃，把重试留给下一次 reconcile，而不是硬着头皮
    // 继续 startLocationUpdatesAsync()。
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    unregisterTask.mockRejectedValue(new Error('boom'));
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('reconciles on an independent watchdog timer even when no sample or schedule change arrives', async () => {
    // 心跳静默失活时，三个触发源（start() 只跑一次、日程订阅要等用户凑巧去改、
    // handleSample() 恰恰是已经停了的那个）全都指望不上。watchdog 定时器必须
    // 独立于这三者，自己把 reconcile 叫起来，才能发现"注册看着健在、其实早就
    // 不投递了"这种状态。
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    jest.useFakeTimers();
    try {
      await coordinator.start();
      getRegisteredTasks.mockClear();

      jest.advanceTimersByTime(300_000);
      await flushMicrotasks();

      expect(getRegisteredTasks).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops the watchdog timer on stop() so it does not keep reconciling after teardown', async () => {
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(true)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    jest.useFakeTimers();
    try {
      await coordinator.start();
      await coordinator.stop();
      getRegisteredTasks.mockClear();

      jest.advanceTimersByTime(600_000);
      await flushMicrotasks();

      expect(getRegisteredTasks).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves the registration alone once a heartbeat has confirmed it is delivering', async () => {
    // 心跳还在流就说明注册真的在投递，这时候 options 里带不带 foregroundService
    // 都不该去动它——后台唤醒重注册必然丢掉那个字段，据此"修复"就是对着一个
    // 健康的服务做一次多余的 stop+start。
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
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(false)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    await coordinator.start();
    stopUpdates.mockClear();
    startUpdates.mockClear();

    await sampleListener?.({
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy_meters: 10,
      observed_at: '2026-08-18T10:00:00.000Z',
    });

    expect(stopUpdates).not.toHaveBeenCalled();
    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('repairs a registration that lost its foreground service', async () => {
    // 真机上的主故障：guard 任务自己用不带 foregroundService 的同名注册重注册过
    // 一次，原生把常驻前台服务拆了，但 hasStartedLocationUpdatesAsync() 照样是
    // true。改之前协调器只看这个布尔值，会直接早退，服务永远建不回来——而且这份
    // 降级注册被 expo-task-manager 持久化，冷启动也清不掉。
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(false)]);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    // 先真的注销一次，再带 foregroundService 重建——只重注册走原生 setOptions
    // 分支，能不能把服务拉回来取决于 mService 的残留状态，不可靠。
    expect(stopUpdates).toHaveBeenCalledWith(GUARD_TASK_NAME);
    expect(startUpdates).toHaveBeenCalledTimes(1);
    const [, options] = startUpdates.mock.calls[0];
    expect(options?.foregroundService?.notificationBody).toBe('提醒守护运行中');
  });

  it('leaves a degraded registration alone while the app is backgrounded', async () => {
    // 后台带 foregroundService 注册会被原生直接拒（ForegroundServiceStartNot-
    // AllowedException），这时候硬 stop 只会把仅剩的定位任务也弄没，比维持现状
    // 更糟。等回到前台的那次 reconcile 再修。
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(false)]);
    foregrounded.mockReturnValue(false);
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(stopUpdates).not.toHaveBeenCalled();
    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('treats an unreadable registration list as "do not touch"', async () => {
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockRejectedValue(new Error('boom'));
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(stopUpdates).not.toHaveBeenCalled();
    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('gives up the repair when clearing the degraded registration fails', async () => {
    hasStarted.mockResolvedValue(true);
    getRegisteredTasks.mockResolvedValue([registeredTask(false)]);
    stopUpdates.mockRejectedValue(new Error('boom'));
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('falls back to the local running flag when hasStartedLocationUpdatesAsync throws', async () => {
    hasStarted.mockRejectedValue(new Error('boom'));
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    // 查原生真实状态失败 → 用本地 running（此刻 false）→ 照常注册
    expect(startUpdates).toHaveBeenCalledTimes(1);
  });

  it('does not let a getForegroundPermissionsAsync failure reject start()', async () => {
    getForeground.mockRejectedValue(new Error('boom'));
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    // 改之前：这次原生调用不兜错的话，start() 会直接 reject，把整个
    // AppRuntime 的启动流程一起炸掉，而不是仅仅这次 reconcile 没启动成功。
    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(startUpdates).not.toHaveBeenCalled();
  });

  it('swallows a startLocationUpdatesAsync failure', async () => {
    startUpdates.mockRejectedValue(new Error('boom'));
    const reader = createReader([timeSchedule()]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });

    await coordinator.start();

    expect(startUpdates).toHaveBeenCalledTimes(1);
  });

  it('swallows a stopLocationUpdates failure', async () => {
    const schedule = timeSchedule();
    const reader = createReader([schedule]);
    const coordinator = new ReminderGuardCoordinator({
      schedules: reader,
      handleLocation: jest.fn(async () => {}),
    });
    await coordinator.start();
    hasStarted.mockResolvedValue(true);

    // 触发停止时让 hasStartedLocationUpdatesAsync 抛错 → 走 catch 吞掉
    hasStarted.mockRejectedValue(new Error('boom'));
    schedule.runtime = { ...schedule.runtime, reminder_disposition_state: 'confirmed' };
    reader.emit();
    await flushMicrotasks();

    expect(stopUpdates).not.toHaveBeenCalled();
  });
});
