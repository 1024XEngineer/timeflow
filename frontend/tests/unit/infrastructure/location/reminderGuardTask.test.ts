import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * 跟 geofenceTask.test.ts 同一条约束：真正碰数据库的那段（openDatabase() → loadStorageModules()
 * 动态 import 'expo-sqlite'）在这个 Jest 环境里必然失败返回 null（没有
 * --experimental-vm-modules，裸 await import() 会直接抛错），所以 runHeadlessLocationPass /
 * runTimeFallbackPass / runStuckPendingPass 拿到连接之后的逻辑无法从单测触达。这里只覆盖
 * 连接边界之前的同步路由：错误分支、无位置样本分支、有订阅者时的分发、无订阅者时的
 * headless 入口，以及每次唤醒无条件执行的兜底 pass 的入口（openDatabase 拿 null 即返回）。
 */

type TaskExecutor = (args: { data: unknown; error: unknown }) => Promise<void>;

const mockIsTaskDefined = jest.fn<(name: string) => boolean>();
const mockDefineTask = jest.fn<(name: string, executor: TaskExecutor) => void>();

jest.mock('expo-task-manager', () => ({
  isTaskDefined: (name: string) => mockIsTaskDefined(name),
  defineTask: (name: string, executor: TaskExecutor) => mockDefineTask(name, executor),
}));

jest.mock('expo-location', () => ({}));

type Sample = {
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  observed_at: string;
};

function locationPayload(
  overrides: Partial<{ lat: number; lon: number; accuracy: number | undefined; ts: number }> = {},
) {
  const timestamp = overrides.ts ?? 1_752_000_000_000;
  return {
    locations: [
      {
        coords: {
          latitude: overrides.lat ?? 31.2304,
          longitude: overrides.lon ?? 121.4737,
          accuracy: overrides.accuracy,
        },
        timestamp,
      },
    ],
  };
}

/** 每个测试都重新 require 模块，拿到一份干净的 listeners 集合和被捕获的 task executor。 */
function loadModule(): {
  module: typeof import('../../../../src/infrastructure/location/reminderGuardTask');
  executor: TaskExecutor;
} {
  mockIsTaskDefined.mockReturnValue(false);
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module registry per test needs require(), not static import
  const required = require('../../../../src/infrastructure/location/reminderGuardTask');
  const module: typeof import('../../../../src/infrastructure/location/reminderGuardTask') =
    required;
  const executor = mockDefineTask.mock.calls.at(-1)?.[1] as TaskExecutor;
  return { module, executor };
}

describe('resolveNextPollIntervalMs', () => {
  it('falls back to the sparsest interval when there is no sample or no targets', () => {
    const { module } = loadModule();
    expect(module.resolveNextPollIntervalMs(null, [{ latitude: 31.23, longitude: 121.47 }])).toBe(
      300_000,
    );
    expect(module.resolveNextPollIntervalMs({ latitude: 31.23, longitude: 121.47 }, [])).toBe(
      300_000,
    );
  });

  it('picks the nearest target among several to decide the interval', () => {
    const { module } = loadModule();
    const sample = { latitude: 31.2304, longitude: 121.4737 };
    const near = { latitude: 31.2304, longitude: 121.4737 }; // ~0m away
    const far = { latitude: 31.32, longitude: 121.4737 }; // far away
    expect(module.resolveNextPollIntervalMs(sample, [far, near])).toBe(15_000);
  });
});

describe('guard task definition and subscription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('defines the task only once, keyed by GUARD_TASK_NAME', () => {
    const { module } = loadModule();
    expect(module.GUARD_TASK_NAME).toBe('timeflow-reminder-guard');
    expect(mockDefineTask).toHaveBeenCalledWith('timeflow-reminder-guard', expect.any(Function));
  });

  it('does not redefine the task if it is already defined', () => {
    mockIsTaskDefined.mockReturnValue(true);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../../src/infrastructure/location/reminderGuardTask');
    expect(mockDefineTask).not.toHaveBeenCalled();
  });

  it('subscribeGuardTaskEvents stops delivering once unsubscribed', () => {
    const { module } = loadModule();
    const listener = jest.fn();
    const unsubscribe = module.subscribeGuardTaskEvents(listener);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('guard task executor routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('ignores the callback when TaskManager reports an error', async () => {
    const { executor } = loadModule();
    await expect(executor({ data: undefined, error: new Error('boom') })).resolves.toBeUndefined();
  });

  it('runs the fallback passes when woken with no location payload', async () => {
    const { module, executor } = loadModule();
    const listener = jest.fn();
    module.subscribeGuardTaskEvents(listener);

    // 没有位置样本时不喂任何 listener；但时间型兜底 + 卡住扫描这两个 pass 无条件执行（拿 null 即返回）。
    await expect(executor({ data: undefined, error: null })).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispatches the last location sample to every live listener', async () => {
    const { module, executor } = loadModule();
    const first = jest.fn();
    const second = jest.fn();
    module.subscribeGuardTaskEvents(first);
    module.subscribeGuardTaskEvents(second);

    await executor({ data: locationPayload({ ts: 1_752_000_000_000, accuracy: 10 }), error: null });

    const expected: Sample = {
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy_meters: 10,
      observed_at: new Date(1_752_000_000_000).toISOString(),
    };
    expect(first).toHaveBeenCalledWith(expected);
    expect(second).toHaveBeenCalledWith(expected);
  });

  it('falls back to accuracy 0 when the location sample omits accuracy', async () => {
    const { module, executor } = loadModule();
    const listener = jest.fn();
    module.subscribeGuardTaskEvents(listener);

    await executor({ data: locationPayload({ accuracy: undefined }), error: null });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ accuracy_meters: 0 }));
  });

  it('completes a headless pass without live listeners (openDatabase returns null)', async () => {
    const { executor } = loadModule();
    // 没有任何订阅者 → listeners.size === 0 → 走 headless 分支，openDatabase 拿到 null 即返回，
    // 接着无条件跑 runTimeFallbackPass/runStuckPendingPass（同样拿 null 即返回）。
    await expect(executor({ data: locationPayload(), error: null })).resolves.toBeUndefined();
  });
});
