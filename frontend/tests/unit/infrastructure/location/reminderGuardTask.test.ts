import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';

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

/**
 * 不能 jest.mock('react-native')——整个模块被替换掉之后 expo-modules-core 拿不到
 * Platform.select，jest-expo 的 setup 会在 resetModules 时直接炸。这里只改真实
 * AppState 上的那一个属性。
 */
function setAppState(state: string): void {
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true });
}

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

describe('isAppForegrounded', () => {
  /**
   * 这个判定决定 refreshGuardRegistration() 每次重注册带不带 foregroundService，
   * 而 expo-location 对两种形态的前台要求正好相反（带着在后台会抛、不带在前台
   * 会把常驻服务拆掉），所以它必须严格等价于"AppState 是不是 active"，
   * inactive（iOS 来电/下拉通知栏那种过渡态）不能算前台。
   */
  it('only treats the active AppState as foreground', () => {
    const { module } = loadModule();
    for (const [state, expected] of [
      ['active', true],
      ['background', false],
      ['inactive', false],
      ['unknown', false],
    ] as const) {
      setAppState(state);
      expect(module.isAppForegrounded()).toBe(expected);
    }
    setAppState('active');
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

  it('runs the fallback passes when woken with no location payload and no live listener', async () => {
    const { executor } = loadModule();

    // 没有位置样本、也没有活着的会话（taskListener 为空）→ 地点判定那一支什么都不
    // 分发，但时间型兜底 + 卡住扫描这两个 pass 跟地点样本无关，照样无条件执行
    // （openDatabase 拿 null 即返回，这里只验证不会抛错）。
    await expect(executor({ data: undefined, error: null })).resolves.toBeUndefined();
  });

  it('dispatches the last location sample to the current listener, superseding any earlier one', async () => {
    // 单槽、后来者顶掉前任。这个语义是为了防泄漏：ReminderGuardCoordinator 在
    // createAppServices() 里构造，而 AppRoot 的 useMemo 会在 Fast Refresh 时把整个
    // 服务容器重建一遍且不销毁旧实例——用 Set 的话订阅者只增不减（围栏那边真机上
    // 实测涨到 3 个，同一事件被处理三遍）。
    const { module, executor } = loadModule();
    const stale = jest.fn();
    const current = jest.fn();
    module.subscribeGuardTaskEvents(stale);
    module.subscribeGuardTaskEvents(current);

    await executor({ data: locationPayload({ ts: 1_752_000_000_000, accuracy: 10 }), error: null });

    const expected: Sample = {
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy_meters: 10,
      observed_at: new Date(1_752_000_000_000).toISOString(),
    };
    expect(current).toHaveBeenCalledWith(expected);
    expect(stale).not.toHaveBeenCalled();
  });

  it('a superseded listener cannot clear the current slot on its late unsubscribe', async () => {
    const { module, executor } = loadModule();
    const stale = jest.fn();
    const current = jest.fn();
    const disposeStale = module.subscribeGuardTaskEvents(stale);
    module.subscribeGuardTaskEvents(current);
    // 旧实例迟到的退订不能把现役 listener 一起清掉——否则会掉进 headless 分支。
    disposeStale();

    await executor({ data: locationPayload(), error: null });

    expect(current).toHaveBeenCalledTimes(1);
  });

  it('falls back to accuracy 0 when the location sample omits accuracy', async () => {
    const { module, executor } = loadModule();
    const listener = jest.fn();
    module.subscribeGuardTaskEvents(listener);

    await executor({ data: locationPayload({ accuracy: undefined }), error: null });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ accuracy_meters: 0 }));
  });

  it('completes a headless location pass when there is no listener and the app is backgrounded', async () => {
    // setAppState 必须在 loadModule() 之后调用——loadModule() 内部 jest.resetModules()
    // 会让 react-native 也被重新 require 一遍，先 setAppState 再 loadModule 等于改了
    // 一个马上被丢弃的旧模块实例，新模块读到的还是默认值，不会真的生效。
    const { executor } = loadModule();
    setAppState('background');
    // 没有订阅者 且 App 不在前台 → 走 headless 地点判定，openDatabase 拿到 null 即
    // 返回，接着无条件跑 runTimeFallbackPass/runStuckPendingPass（同样拿 null 即返回）。
    await expect(executor({ data: locationPayload(), error: null })).resolves.toBeUndefined();
    setAppState('active');
  });

  it('skips the headless location pass when there is no listener but the app is foregrounded', async () => {
    // 槽位空不等于会话已死。真机上实测：App 开在前台、界面正常渲染，槽位却连续
    // 8 个 tick 是空的（旧 coordinator 已退订、新的还没 start 到位的窗口期）。这时
    // 走 headless 地点判定会绕过 LocalReminderApplication 的内存锁去认领并弹提醒，
    // 正是这个仓库反复出现的"同一条提醒弹好几遍"。宁可漏一次轮询。时间型兜底 +
    // 卡住扫描不受影响，照样会跑（跟地点判定完全独立，见源码里的说明）。
    //
    // setAppState 必须在 loadModule() 之后调用，理由同上一个用例。
    const { module, executor } = loadModule();
    setAppState('active');
    const listener = jest.fn();
    const dispose = module.subscribeGuardTaskEvents(listener);
    dispose();

    await expect(executor({ data: locationPayload(), error: null })).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});
