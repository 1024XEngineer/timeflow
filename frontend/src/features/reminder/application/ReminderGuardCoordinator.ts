import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { LocalScheduleReader } from './interfaces';
import type { GeoPoint, LocalReminderSchedule, LocationSample } from '../domain';
import { resolveGeofenceCenter, resolveWatchMode } from '../domain/geofence';
import {
  GUARD_NOTIFICATION_BODY,
  GUARD_NOTIFICATION_TITLE,
  GUARD_TASK_NAME,
  isAppForegrounded,
  resolveNextPollIntervalMs,
  subscribeGuardTaskEvents,
  type GuardTaskSample,
} from '../../../infrastructure/location/reminderGuardTask';

/** 真机上 hasStarted/stopLocationUpdates 偶发不返回；登出不能卡在这里。 */
const LOCATION_STOP_TIMEOUT_MS = 2_000;

/**
 * 注册声称在跑、却这么久一次心跳都收不到，就当它已经不投递了。取最疏轮询间隔
 * （5min）的两倍：宁可发现得晚，也不能误判去拆一个还在正常投递的注册。
 */
const REGISTRATION_STALE_AFTER_MS = 600_000;

/**
 * 独立于心跳事件的兜底重试节奏。isRegistrationStale() 要判的恰恰是"心跳已经
 * 不再来了"这件事——如果只在 handleSample()/日程变化触发的 reconcile 里查，
 * 那么注册一旦在后台悄悄失活（收到过一次心跳、之后再没有），就再也没有任何
 * 代码会主动重新检查，会一直卡到用户手动改日程或重启 App。这里独立定时唤醒
 * 一次 reconcile，跟心跳来不来无关。取跟 REGISTRATION_STALE_AFTER_MS 同一个
 * 最疏轮询间隔，10 分钟的陈旧窗口内能查两次，发现得不算晚。
 */
const WATCHDOG_INTERVAL_MS = 300_000;

/**
 * 原生注册其实有三种状态，而 hasStartedLocationUpdatesAsync() 只能回答把后两种
 * 合并之后的那个布尔值（"注册着吗"）：
 *
 * - `absent`     没注册，需要带 foregroundService 建起来。
 * - `foreground` 注册着，且注册项带 foregroundService——常驻前台服务活着，什么都不用做。
 * - `degraded`   注册着，但注册项**不带** foregroundService——定位任务还在跑，
 *                前台服务已经被原生拆掉了。这是真机上最常见也最致命的一种。
 * - `unknown`    查不出来（原生调用抛错），一律不动，留到下次 reconcile 再判。
 */
type GuardRegistrationState = 'absent' | 'foreground' | 'degraded' | 'unknown';

export type ReminderGuardDependencies = {
  schedules: LocalScheduleReader;
  /** 收到位置心跳后，喂给 LocalReminderApplication 走完整的地点提醒判定链路。 */
  handleLocation: (sample: LocationSample) => Promise<void>;
};

/**
 * 常驻前台服务的 JS 侧协调器：不是自己起一个原生 Service，而是借用
 * expo-location 已经配置好的 startLocationUpdatesAsync 前台服务能力——只要还有
 * 未完成的提醒（时间型或地点型）就保持它运行，用它把进程钉在 Doze 豁免状态；
 * 停止判定 + 通知文案 + 轮询间隔 全部是纯 JS 逻辑，可以脱离原生单独测试。
 *
 * 时间型日程原生闹钟挂没挂上，这里不判定——那是 reminderGuardTask.ts 每次唤醒
 * 时直接查 AlarmScheduler 持久化状态做的事，这里只回答"要不要让这个前台服务
 * 继续活着"这个更粗粒度的问题。
 */
export class ReminderGuardCoordinator {
  private unsubscribeSchedules: (() => void) | null = null;
  private unsubscribeGuardTask: (() => void) | null = null;
  private started = false;
  /** 每次 start/stop 都加一，用来作废已经过了 started 检查、还卡在 await 上的 reconcile。 */
  private generation = 0;
  private running = false;
  private currentIntervalMs: number | null = null;
  private lastSample: GeoPoint | null = null;
  /**
   * 本进程自己成功建起过这个注册没有。注册记录是持久化的，进程被杀之后它依旧
   * 完好，光看注册状态分不出"我建的"和"上个进程留下的"。
   */
  private ownsRegistration = false;
  /** 上一次收到位置心跳的时刻，用来发现会话中途悄悄断掉的投递。 */
  private lastProgressAt: number | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();
  /** 独立于心跳事件的兜底定时器，见 WATCHDOG_INTERVAL_MS 的说明。 */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dependencies: ReminderGuardDependencies) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    this.unsubscribeGuardTask = subscribeGuardTaskEvents((sample) => {
      void this.handleSample(sample);
    });
    this.unsubscribeSchedules = this.dependencies.schedules.subscribe(() => {
      void this.reconcile();
    });
    this.watchdogTimer = setInterval(() => {
      void this.reconcile();
    }, WATCHDOG_INTERVAL_MS);
    // Node 测试环境下的定时器带 unref()，不调用它 Jest 进程退不出去；React
    // Native 运行时的 setInterval 返回值没有这个方法，特性检测一下就是安全的
    // 空操作——两边都不影响真正的定时逻辑，只影响"这个定时器算不算 keep-alive
    // 句柄"这一件事。
    const maybeUnref = this.watchdogTimer as unknown as { unref?: () => void };
    maybeUnref.unref?.();
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.generation += 1;
    this.ownsRegistration = false;
    this.lastProgressAt = null;
    this.unsubscribeGuardTask?.();
    this.unsubscribeGuardTask = null;
    this.unsubscribeSchedules?.();
    this.unsubscribeSchedules = null;
    if (this.watchdogTimer != null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    await this.stopLocationUpdates();
  }

  private async handleSample(sample: GuardTaskSample): Promise<void> {
    this.lastProgressAt = Date.now();
    this.lastSample = { latitude: sample.latitude, longitude: sample.longitude };
    await this.dependencies.handleLocation(sample);
    await this.reconcile();
  }

  /** 串行化：日程变化和位置心跳可能挤在一起触发，不让两次 reconcile 并发跑。 */
  private reconcile(): Promise<void> {
    const run = this.reconcileChain.then(() => this.reconcileInternal());
    this.reconcileChain = run.catch(() => undefined);
    return run;
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.started && this.generation === generation;
  }

  private async reconcileInternal(): Promise<void> {
    const generation = this.generation;
    if (!this.isCurrentGeneration(generation)) return;
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    // stop() 会先推进 generation 再超时等 native stop。这次 reconcile 可能已经
    // 过了上面的检查、卡在 list 上；回来后不能再停/启定位。
    if (!this.isCurrentGeneration(generation)) return;
    const active = schedules.filter(
      (schedule) =>
        schedule.status === 'active' && schedule.runtime.reminder_disposition_state !== 'confirmed',
    );

    // 临时诊断：区分"reconcile 压根没被调到"和"调到了但在这里就早退"。
    console.warn(`[guard] reconcile active=${active.length}`);

    if (active.length === 0) {
      if (!this.isCurrentGeneration(generation)) return;
      await this.stopLocationUpdates();
      return;
    }

    const locationTargets = active
      .filter((schedule) => schedule.schedule_type === 'location')
      .map((schedule) => resolveGeofenceCenter(schedule, resolveWatchMode(schedule)))
      .filter((center): center is GeoPoint => center != null);

    const intervalMs = resolveNextPollIntervalMs(this.lastSample, locationTargets);
    await this.ensureLocationUpdates(intervalMs, active, generation);
  }

  private async ensureLocationUpdates(
    intervalMs: number,
    active: readonly LocalReminderSchedule[],
    generation: number,
  ): Promise<void> {
    // 已经在跑就不从这条路径碰它——"间隔变化超过阈值就重新注册"这条逻辑，
    // 会在日程列表一变（比如插入第二条日程）时，对着一个可能正在执行/待执行的
    // 后台任务同步地重新调用 startLocationUpdatesAsync()，真机上追出来的一个
    // 大概率解释：这个重新注册跟任务自己的执行窗口撞在一起，引发了 SQLite
    // 连接的并发访问。轮询密度要不要变，交给任务自己下次醒来时决定
    // （reminderGuardTask.ts 的 refreshGuardRegistration，在它自己已经串行的
    // 执行上下文里调），不要跟前台的增删操作同步触发。
    //
    // "已经在跑"查的是原生真实状态，不是本地缓存的 this.running——任务现在
    // 会在查到 0 条待处理日程时自己把原生任务停掉（见 refreshGuardRegistration），
    // 这个协调器不知情，本地标志会跟真实状态脱节；用本地标志判断的话，日程
    // 清空又新增时会被误判成"已经在跑"，永远不会真正重新启动。
    //
    // 但注册状态本身不能当"还在投递"的证据，两个方向都会骗人：
    // - options 带着 foregroundService，进程却已经被杀过一次。注册记录是持久化
    //   的，force-stop 杀不掉，冷启动读到它就一路早退，而真正的投递早断了——
    //   这正是"重启救不回来、只有重装能救"那个卡死状态。
    // - options 没带 foregroundService，服务其实活得好好的。后台唤醒时
    //   refreshGuardRegistration 只能不带这个字段重注册（带上会被原生拒），
    //   于是每次切后台都会把 options 打成这样，回前台再去"修"一个健康的服务。
    // 所以真正的判据是"最近还收不收得到心跳"（isRegistrationStale），注册状态
    // 只用来回答"重建之前要不要先注销一次"。
    const state = await this.resolveRegistrationState();
    const stale = this.isRegistrationStale(state);
    // 临时诊断：这几个值就是下面全部分流的依据，卡住时只看这一行就够。
    console.warn(
      `[guard] state=${state} foregrounded=${isAppForegrounded()} stale=${stale} wantInterval=${intervalMs}`,
    );
    if (!this.isCurrentGeneration(generation)) return;
    if (state === 'unknown') return;

    if (state !== 'absent') {
      if (!stale) {
        this.running = true;
        return;
      }
      // 后台补不回来：带 foregroundService 的注册在后台会被原生直接拒掉，这时候
      // 硬 stop 只会把仅剩的定位任务也弄没，比维持现状更糟。等回到前台的那次
      // reconcile 再修（位置心跳每 15s~5min 就会触发一次 reconcile）。
      if (!isAppForegrounded()) {
        this.running = true;
        return;
      }
      // 必须先真的注销一次再重注册。只重注册走的是原生 setOptions 分支，能不能
      // 把服务拉回来取决于 LocationTaskConsumer 里 mService 的残留状态
      // （stopForegroundService() 只调 mService?.stop()，并不把字段置回 null），
      // 不可靠；先 stop 再 start 走的是 didUnregister → didRegister 这条干净路径，
      // 也正是真机上热重载能"碰巧治好"这个问题时实际发生的序列。
      try {
        await Location.stopLocationUpdatesAsync(GUARD_TASK_NAME);
      } catch (error) {
        console.warn('[guard] failed to clear the stale registration', error);
        return;
      }
      // stopLocationUpdatesAsync() 只解绑位置更新，TaskManager 里那条任务注册还留着
      // ——跟 ExpoLocationMonitor 清理老围栏时遇到的是同一件事。真机实测：进程被杀
      // 之后光 stop 再 start，注册看着建上了（hasStarted=true、options 带着
      // foregroundService、间隔也对），却再也不投递一次样本，只有卸载重装才能恢复。
      // 这里补一次真正的注销，把持久化记录也抹掉，等价于重装那一下。注销失败就
      // 中止本次重建、保留现状——不能继续往下 startLocationUpdatesAsync()：
      // 持久化记录没删掉，走的还是那条"已存在就 setOptions"的原生分支，等于
      // 重新绑上同一条失活的记录，registerTasks 又会把它当健康注册提前返回，
      // 恢复彻底失败且无声无息。留在原状态，等下一次 reconcile（心跳或
      // watchdog 定时器）重试。
      try {
        if (await TaskManager.isTaskRegisteredAsync(GUARD_TASK_NAME)) {
          await TaskManager.unregisterTaskAsync(GUARD_TASK_NAME);
        }
      } catch (error) {
        console.warn('[guard] failed to unregister the stale task', error);
        return;
      }
      if (!this.isCurrentGeneration(generation)) return;
      this.running = false;
    }

    // 只查前台权限：startLocationUpdatesAsync() 传了 foregroundService 配置，走的是
    // "用户可见前台服务"这条路径，expo-location 原生侧本身就不要求
    // ACCESS_BACKGROUND_LOCATION（只有不带 foregroundService、纯后台位置服务那条路径
    // 才需要）——上一版这里连后台权限一起卡，导致用户只给了"仅使用时允许"（没给
    // "始终允许"，这是安卓上很常见的选择）时，连时间型提醒的兜底轮询都启动不了，
    // 跟这条日程要不要用到位置完全没关系。
    // 冷启动时原生模块可能还没链接完，这次调用偶尔会抛错——不兜住的话会一路
    // 传出 reconcile()/start()，把整个 AppRuntime 启动流程炸掉（详见
    // AppProviders.tsx 里 runtime.start() 未 catch 的说明），而不是仅仅这一次
    // reconcile 失败。
    let foreground: Location.PermissionStatus;
    try {
      ({ status: foreground } = await Location.getForegroundPermissionsAsync());
    } catch (error) {
      console.warn('[guard] getForegroundPermissionsAsync failed', error);
      return;
    }
    if (foreground !== 'granted') {
      console.warn('[guard] ensureLocationUpdates skipped: foreground permission not granted');
      return;
    }
    if (!this.isCurrentGeneration(generation)) return;

    try {
      await Location.startLocationUpdatesAsync(GUARD_TASK_NAME, {
        accuracy: Location.Accuracy.High,
        timeInterval: intervalMs,
        distanceInterval: 0,
        foregroundService: {
          notificationTitle: GUARD_NOTIFICATION_TITLE,
          notificationBody: GUARD_NOTIFICATION_BODY,
        },
      });
      if (!this.started) {
        // start 请求发出去时已经登出：this.running 可能仍是 false，普通 stop
        // 会早退，必须强制拆掉刚建上的注册。native stop 卡住也只等超时。
        await this.stopLocationUpdates(true);
        return;
      }
      if (!this.isCurrentGeneration(generation)) return;
      // 临时诊断：这行打出来才代表注册真的建上了；之后多久没有 dispatching sample
      // 就能直接跟 interval 对照，区分"间隔太疏"和"根本不投递"。
      console.warn(`[guard] registered interval=${intervalMs}`);
      this.running = true;
      this.currentIntervalMs = intervalMs;
      this.ownsRegistration = true;
      // 自己刚建起来的注册，在第一次心跳到来之前也算"确认过还活着"，否则紧接着
      // 的那次 reconcile（比如同时又新增了一条日程）会当它是陈旧的再拆一遍。
      this.lastProgressAt = Date.now();
    } catch (error) {
      console.warn('[guard] startLocationUpdatesAsync failed', error);
    }
  }

  /**
   * 注册声称在跑，但它真的还在投递吗？两个判据缺一不可：
   *
   * 1. 本进程自己建过它没有。继承来的注册在冷启动瞬间还会投出一两次心跳（上一份
   *    注册的余波，真机上量到过两条紧挨着的样本），之后就彻底停摆——所以不能拿
   *    "刚收到心跳"当它还活着的证据，只要不是自己建的就一律重建。
   * 2. 自己建的那份，最近还在不在投递。这条管的是会话中途悄悄断掉的情况。
   */
  private isRegistrationStale(state: GuardRegistrationState): boolean {
    if (state === 'absent' || state === 'unknown') return false;
    if (!this.ownsRegistration) return true;
    if (this.lastProgressAt == null) return true;
    return Date.now() - this.lastProgressAt > REGISTRATION_STALE_AFTER_MS;
  }

  /**
   * 判定原生注册处于 GuardRegistrationState 的哪一种。关键在第二步：光问
   * hasStartedLocationUpdatesAsync() 只知道"注册着"，得再把注册项自己的 options
   * 翻出来，看 foregroundService 还在不在，才能区分 foreground 和 degraded。
   */
  private async resolveRegistrationState(): Promise<GuardRegistrationState> {
    let registered: boolean;
    try {
      registered = await Location.hasStartedLocationUpdatesAsync(GUARD_TASK_NAME);
    } catch (error) {
      console.warn('[guard] hasStartedLocationUpdatesAsync failed', error);
      // 查不到原生状态就退回本地标志，保持这次调用之前的语义：本地认为没在跑
      // 就照常尝试注册，认为在跑就别乱动。
      return this.running ? 'unknown' : 'absent';
    }
    if (!registered) return 'absent';

    try {
      const tasks = await TaskManager.getRegisteredTasksAsync();
      const task = tasks.find((entry) => entry.taskName === GUARD_TASK_NAME);
      return task?.options?.foregroundService == null ? 'degraded' : 'foreground';
    } catch (error) {
      // 拿不到注册详情就别贸然 stop 再 start——万一这会儿在后台就起不回来，
      // 反而把一个还能用的注册弄没了。
      console.warn('[guard] getRegisteredTasksAsync failed', error);
      return 'unknown';
    }
  }

  private async stopLocationUpdates(force = false): Promise<void> {
    if (!this.running && !force) return;
    try {
      await raceWithTimeout(
        (async () => {
          const hasStarted = await Location.hasStartedLocationUpdatesAsync(GUARD_TASK_NAME);
          if (hasStarted) {
            await Location.stopLocationUpdatesAsync(GUARD_TASK_NAME);
          }
        })(),
        LOCATION_STOP_TIMEOUT_MS,
      );
    } catch (error) {
      console.warn('[guard] stopLocationUpdatesAsync failed', error);
    } finally {
      this.running = false;
      this.currentIntervalMs = null;
    }
  }
}

function raceWithTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs);
    operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
