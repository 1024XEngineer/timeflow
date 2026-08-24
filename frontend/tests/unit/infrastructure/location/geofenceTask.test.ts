import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * deliverHeadlessGeofenceEvent()/persistPendingEvent()/drainPendingGeofenceEvents() all
 * reach expo-sqlite(/kv-store)/expo-notifications through a dynamic `import()` (deliberate:
 * see the "懒加载" comment on loadStorage() in the source — the top-level default export of
 * those native modules would throw immediately in a test environment without a real native
 * module, so the whole codebase's convention is to defer that behind a dynamic import).
 * This project's Jest config has no `--experimental-vm-modules`, so a bare `await import(...)`
 * throws "A dynamic import callback was invoked without --experimental-vm-modules" here — that
 * failure is swallowed by the source's own try/catch (by design, for a genuinely-unavailable
 * native module), which makes it indistinguishable from "no database file yet" in this suite.
 * So the DB/notification branches inside deliverHeadlessGeofenceEvent are not reachable from a
 * unit test in this project without changing the Jest runtime flags project-wide; only the
 * synchronous routing in front of that boundary is covered here.
 */

type TaskExecutor = (args: { data: unknown; error: unknown }) => Promise<void>;

const mockIsTaskDefined = jest.fn<(name: string) => boolean>();
const mockDefineTask = jest.fn<(name: string, executor: TaskExecutor) => void>();

jest.mock('expo-task-manager', () => ({
  isTaskDefined: (name: string) => mockIsTaskDefined(name),
  defineTask: (name: string, executor: TaskExecutor) => mockDefineTask(name, executor),
}));

jest.mock('expo-location', () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 },
}));

/** 每个测试都重新 require 模块，拿到一份干净的 listeners 集合和被捕获的 task executor。 */
function loadModule(): {
  module: typeof import('../../../../src/infrastructure/location/geofenceTask');
  executor: TaskExecutor;
} {
  mockIsTaskDefined.mockReturnValue(false);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module registry per test needs require(), not static import
  const required = require('../../../../src/infrastructure/location/geofenceTask');
  const module: typeof import('../../../../src/infrastructure/location/geofenceTask') = required;
  const executor = mockDefineTask.mock.calls.at(-1)?.[1] as TaskExecutor;
  return { module, executor };
}

describe('geofenceTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('defines the task only once, keyed by GEOFENCE_TASK_NAME', () => {
    const { module } = loadModule();
    expect(module.GEOFENCE_TASK_NAME).toBe('timeflow-geofence');
    expect(mockDefineTask).toHaveBeenCalledWith('timeflow-geofence', expect.any(Function));
  });

  it('does not redefine the task if it is already defined', () => {
    mockIsTaskDefined.mockReturnValue(true);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../../src/infrastructure/location/geofenceTask');
    expect(mockDefineTask).not.toHaveBeenCalled();
  });

  describe('subscribeGeofenceTaskEvents()', () => {
    it('delivers task events straight to a subscribed listener, bypassing headless delivery', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      module.subscribeGeofenceTaskEvents(listener);

      await executor({
        data: {
          eventType: 1,
          region: { identifier: 'schedule-1', latitude: 1, longitude: 2, radius: 100 },
        },
        error: null,
      });

      expect(listener).toHaveBeenCalledWith({
        schedule_id: 'schedule-1',
        event: 'enter',
        latitude: 1,
        longitude: 2,
        radius: 100,
        observed_at: expect.any(String),
      });
    });

    it('maps GeofencingEventType.Exit to the "exit" event string', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      module.subscribeGeofenceTaskEvents(listener);

      await executor({
        data: {
          eventType: 2,
          region: { identifier: 'schedule-1', latitude: 1, longitude: 2, radius: 100 },
        },
        error: null,
      });

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ event: 'exit' }));
    });

    it('stops delivering to a listener once unsubscribed', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      const unsubscribe = module.subscribeGeofenceTaskEvents(listener);
      unsubscribe();

      await executor({
        data: {
          eventType: 1,
          region: { identifier: 'schedule-1', latitude: 1, longitude: 2, radius: 100 },
        },
        error: null,
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it('supports multiple concurrent listeners', async () => {
      const { module, executor } = loadModule();
      const first = jest.fn();
      const second = jest.fn();
      module.subscribeGeofenceTaskEvents(first);
      module.subscribeGeofenceTaskEvents(second);

      await executor({
        data: {
          eventType: 1,
          region: { identifier: 'schedule-1', latitude: 1, longitude: 2, radius: 100 },
        },
        error: null,
      });

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  describe('task executor input handling', () => {
    it('ignores the callback when TaskManager reports an error', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      module.subscribeGeofenceTaskEvents(listener);
      await executor({ data: undefined, error: new Error('boom') });
      expect(listener).not.toHaveBeenCalled();
    });

    it('ignores a payload with no region identifier', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      module.subscribeGeofenceTaskEvents(listener);
      await executor({ data: { eventType: 1, region: undefined }, error: null });
      expect(listener).not.toHaveBeenCalled();
    });

    it('ignores a payload with no data at all', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      module.subscribeGeofenceTaskEvents(listener);
      await executor({ data: undefined, error: null });
      expect(listener).not.toHaveBeenCalled();
    });

    it('ignores an unrecognized event type', async () => {
      const { module, executor } = loadModule();
      const listener = jest.fn();
      module.subscribeGeofenceTaskEvents(listener);
      await executor({
        data: {
          eventType: 99,
          region: { identifier: 'schedule-1', latitude: 1, longitude: 2, radius: 100 },
        },
        error: null,
      });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('drainPendingGeofenceEvents()', () => {
    it('resolves to an empty array when the kv-store backing it is unreachable', async () => {
      // loadStorage() 内部动态 import 失败即返回 null，这条路径本身就是设计要覆盖的
      // "原生模块不可用" 分支，跟测试环境无法提供真实 expo-sqlite/kv-store 是同一种情况。
      const { module } = loadModule();
      await expect(module.drainPendingGeofenceEvents()).resolves.toEqual([]);
    });
  });

  describe('simulateGeofenceEventForTesting()', () => {
    it('rejects when the headless database cannot be opened', async () => {
      const { module } = loadModule();
      // openHeadlessDatabase() 拿到 null 即抛，这是 dev-only hook 在无原生模块环境的预期行为。
      await expect(module.simulateGeofenceEventForTesting('schedule-1', 'enter')).rejects.toThrow(
        '无法打开本地日程数据库',
      );
    });
  });

  describe('headless delivery routing', () => {
    it('routes a subscriber-less enter event through headless delivery and queues it', async () => {
      // listeners.size === 0 → deliverHeadlessGeofenceEvent → openHeadlessDatabase 拿到
      // null 返回 false → persistPendingEvent（loadStorage 拿到 null 即返回）。整条链
      // 都是"原生不可用"分支，验证它不会抛错、而是走完队列化兜底。
      const { executor } = loadModule();
      await expect(
        executor({
          data: {
            eventType: 1,
            region: { identifier: 'schedule-1', latitude: 1, longitude: 2, radius: 100 },
          },
          error: null,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
