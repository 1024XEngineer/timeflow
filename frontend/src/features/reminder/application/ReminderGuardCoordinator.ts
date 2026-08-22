import * as Location from 'expo-location';

import type { LocalScheduleReader } from './interfaces';
import type { GeoPoint, LocalReminderSchedule, LocationSample } from '../domain';
import { resolveGeofenceCenter, resolveWatchMode } from '../domain/geofence';
import { resolveEffectiveTriggerAt } from '../domain/timeWindow';
import {
  GUARD_TASK_NAME,
  resolveNextPollIntervalMs,
  subscribeGuardTaskEvents,
  type GuardTaskSample,
} from '../../../infrastructure/location/reminderGuardTask';

const NOTIFICATION_TITLE = 'Timeflow 提醒守护';
const RESTART_INTERVAL_RATIO_THRESHOLD = 0.2;

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
    const { status: foreground } = await Location.getForegroundPermissionsAsync();
    if (foreground !== 'granted') {
      console.warn('[guard] ensureLocationUpdates skipped: foreground permission not granted');
      return;
    }
    const { status: background } = await Location.getBackgroundPermissionsAsync();
    if (background !== 'granted') {
      console.warn('[guard] ensureLocationUpdates skipped: background permission not granted');
      return;
    }

    const intervalChangedEnough =
      this.currentIntervalMs == null ||
      Math.abs(intervalMs - this.currentIntervalMs) / this.currentIntervalMs >
        RESTART_INTERVAL_RATIO_THRESHOLD;

    if (this.running && !intervalChangedEnough) {
      return;
    }

    try {
      await Location.startLocationUpdatesAsync(GUARD_TASK_NAME, {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: intervalMs,
        distanceInterval: 0,
        foregroundService: {
          notificationTitle: NOTIFICATION_TITLE,
          notificationBody: describeGuardNotification(active),
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

/**
 * 常驻通知文案：有时间型日程时显示最近一条的倒计时（信息量更大，优先展示）；
 * 只有地点型日程时改成"正在监听 N 个"——地点型没有确定的下一个触发时刻，凑不出
 * 倒计时。
 */
function describeGuardNotification(active: readonly LocalReminderSchedule[]): string {
  const timeSchedules = active.filter((schedule) => schedule.schedule_type === 'time');
  const locationCount = active.length - timeSchedules.length;

  const next = timeSchedules
    .map((schedule) => ({ schedule, triggerAt: resolveNextTriggerAt(schedule) }))
    .filter(
      (entry): entry is { schedule: LocalReminderSchedule; triggerAt: number } =>
        entry.triggerAt != null,
    )
    .sort((a, b) => a.triggerAt - b.triggerAt)[0];

  if (next == null) {
    return locationCount > 0 ? `正在监听 ${locationCount} 个地点提醒` : '正在后台监控提醒';
  }

  const minutesLeft = Math.max(0, Math.round((next.triggerAt - Date.now()) / 60_000));
  const countdown = minutesLeft <= 0 ? '即将到时' : `还有约 ${minutesLeft} 分钟`;
  const suffix = locationCount > 0 ? `，另有 ${locationCount} 个地点提醒监听中` : '';
  return `下一条：${next.schedule.title}，${countdown}${suffix}`;
}

function resolveNextTriggerAt(schedule: LocalReminderSchedule): number | null {
  const triggerAt = resolveEffectiveTriggerAt(schedule);
  if (triggerAt == null) return null;
  const parsed = Date.parse(triggerAt);
  return Number.isNaN(parsed) ? null : parsed;
}
