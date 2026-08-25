import * as Location from 'expo-location';

import type { LocalScheduleReader } from './interfaces';
import type { GeoPoint, LocalReminderSchedule, LocationSample } from '../domain';
import { resolveGeofenceCenter, resolveWatchMode } from '../domain/geofence';
import {
  GUARD_NOTIFICATION_TITLE,
  GUARD_TASK_NAME,
  resolveNextPollIntervalMs,
  subscribeGuardTaskEvents,
  type GuardTaskSample,
} from '../../../infrastructure/location/reminderGuardTask';

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
  private running = false;
  private currentIntervalMs: number | null = null;
  private lastSample: GeoPoint | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: ReminderGuardDependencies) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribeGuardTask = subscribeGuardTaskEvents((sample) => {
      void this.handleSample(sample);
    });
    this.unsubscribeSchedules = this.dependencies.schedules.subscribe(() => {
      void this.reconcile();
    });
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribeGuardTask?.();
    this.unsubscribeGuardTask = null;
    this.unsubscribeSchedules?.();
    this.unsubscribeSchedules = null;
    await this.stopLocationUpdates();
  }

  private async handleSample(sample: GuardTaskSample): Promise<void> {
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

  private async reconcileInternal(): Promise<void> {
    if (!this.started) return;
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    const active = schedules.filter(
      (schedule) =>
        schedule.status === 'active' && schedule.runtime.reminder_disposition_state !== 'confirmed',
    );

    if (active.length === 0) {
      await this.stopLocationUpdates();
      return;
    }

    const locationTargets = active
      .filter((schedule) => schedule.schedule_type === 'location')
      .map((schedule) => resolveGeofenceCenter(schedule, resolveWatchMode(schedule)))
      .filter((center): center is GeoPoint => center != null);

    const intervalMs = resolveNextPollIntervalMs(this.lastSample, locationTargets);
    await this.ensureLocationUpdates(intervalMs, active);
  }

  private async ensureLocationUpdates(
    intervalMs: number,
    active: readonly LocalReminderSchedule[],
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
    let alreadyRunning: boolean;
    try {
      alreadyRunning = await Location.hasStartedLocationUpdatesAsync(GUARD_TASK_NAME);
    } catch (error) {
      console.warn('[guard] hasStartedLocationUpdatesAsync failed', error);
      alreadyRunning = this.running;
    }
    if (alreadyRunning) {
      this.running = true;
      return;
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

    try {
      await Location.startLocationUpdatesAsync(GUARD_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: intervalMs,
        distanceInterval: 0,
        foregroundService: {
          notificationTitle: GUARD_NOTIFICATION_TITLE,
          notificationBody: '提醒守护运行中',
        },
      });
      this.running = true;
      this.currentIntervalMs = intervalMs;
    } catch (error) {
      console.warn('[guard] startLocationUpdatesAsync failed', error);
    }
  }

  private async stopLocationUpdates(): Promise<void> {
    if (!this.running) return;
    try {
      const hasStarted = await Location.hasStartedLocationUpdatesAsync(GUARD_TASK_NAME);
      if (hasStarted) {
        await Location.stopLocationUpdatesAsync(GUARD_TASK_NAME);
      }
    } catch (error) {
      console.warn('[guard] stopLocationUpdatesAsync failed', error);
    } finally {
      this.running = false;
      this.currentIntervalMs = null;
    }
  }
}
