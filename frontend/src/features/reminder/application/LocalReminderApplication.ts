import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
  ReminderApplicationResult,
  ReminderConfirmedDisposition,
  ReminderPermissionBlockedEvent,
  ReminderSnoozeRequest,
  LocationMonitorEvent,
  LocationWatchHandle,
  AlarmScheduleReceipt,
  AlarmNativeEvent,
  DevicePermission,
} from './interfaces';
import type {
  DeliveryChannel,
  LocalReminderSchedule,
  LocationSample,
  ReminderDeliveryReceipt,
  ReminderDeliveryRequest,
  ReminderDisposition,
  ReminderRegistration,
  ReminderRuntimeState,
  ReminderTrigger,
  ReminderTriggerReason,
} from '../domain';
import { DEFAULT_SNOOZE_MINUTES } from '../domain';
import {
  distanceMeters,
  evaluateGeofence,
  resolveGeofenceCenter,
  resolveWatchMode,
} from '../domain/geofence';
import type { AlarmSoundTier } from '../domain/strengthDelivery';
import { composeReminderSpeech, resolveStrengthDeliveryPlan } from '../domain/strengthDelivery';
import {
  isSnoozeActive,
  isSnoozeExpired,
  isTimeWindowReached,
  resolveEffectiveTriggerAt,
  resolveSnoozeUntil,
} from '../domain/timeWindow';

type RegistrationRecord = ReminderRegistration & {
  schedule: LocalReminderSchedule;
};

const EMPTY_CHANNELS: ReminderDeliveryReceipt['channels'] = [];
/** 跟 reminderGuardTask.ts 的同名常量保持一致——两处合起来覆盖会话存活/已死两种场景。 */
const STUCK_PENDING_THRESHOLD_MS = 2 * 60_000;

function emptyRegistration(scheduleId: string): ReminderRegistration {
  return {
    schedule_id: scheduleId,
    time_listener_id: null,
    location_listener_id: null,
    alarm_id: null,
  };
}

/** 本地提醒协调器：通过已注入端口完成注册、触发、送达与确认/延后。 */
export class LocalReminderApplication implements ReminderApplicationPort {
  private started = false;
  private timeListenerId: string | null = null;
  private unsubscribePresenter: (() => void) | null = null;
  private unsubscribeSchedules: (() => void) | null = null;
  private unsubscribeAlarms: (() => void) | null = null;
  private readonly registrations = new Map<string, RegistrationRecord>();
  private readonly activeDeliveries = new Set<string>();
  private readonly deliverLocks = new Set<string>();
  /** 原生已响铃、由原生 UI 承接展示的日程；JS 不再叠加弹窗/TTS。 */
  private readonly nativePresented = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly permissionBlockedListeners = new Set<
    (event: ReminderPermissionBlockedEvent) => void
  >();
  private opChain: Promise<void> = Promise.resolve();
  /** 每次 stop / 失败回滚自增；停机前开始的工作持有旧世代，重启后仍视为已取消。 */
  private generation = 0;
  private acceptingWork = true;

  constructor(readonly dependencies: ReminderApplicationDependencies) {}

  async start(): Promise<void> {
    return this.enqueueOp(() => this.startInternal());
  }

  async stop(): Promise<void> {
    this.invalidate();
    this.detachListeners();
    return this.enqueueOp(() => this.stopInternal());
  }

  async register(schedule: LocalReminderSchedule): Promise<ReminderRegistration> {
    const generation = this.generation;
    return this.enqueueOp(() => this.registerInternal(schedule, generation));
  }

  async rebuild(): Promise<readonly ReminderRegistration[]> {
    return this.enqueueRebuild();
  }

  onPermissionBlocked(listener: (event: ReminderPermissionBlockedEvent) => void): () => void {
    this.permissionBlockedListeners.add(listener);
    return () => {
      this.permissionBlockedListeners.delete(listener);
    };
  }

  async handleTime(tick: { observed_at: string }): Promise<void> {
    const generation = this.generation;
    return this.track(this.runHandleTime(tick, generation));
  }

  async handleLocation(sample: LocationSample): Promise<void> {
    const generation = this.generation;
    return this.track(this.runHandleLocation(sample, generation));
  }

  async deliver(trigger: ReminderTrigger): Promise<ReminderDeliveryReceipt> {
    const generation = this.generation;
    return this.track(this.runDeliver(trigger, generation));
  }

  async confirm(scheduleId: string, confirmedAt: string): Promise<ReminderApplicationResult> {
    const generation = this.generation;
    return this.enqueueOp(() => this.confirmInternal(scheduleId, confirmedAt, generation));
  }

  async snooze(request: ReminderSnoozeRequest): Promise<ReminderApplicationResult> {
    const generation = this.generation;
    return this.enqueueOp(() => this.snoozeInternal(request, generation));
  }

  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    return work.finally(() => {
      this.inFlight.delete(work);
    });
  }

  private isLive(generation: number): boolean {
    return this.acceptingWork && generation === this.generation;
  }

  private invalidate(): void {
    this.generation += 1;
    this.acceptingWork = false;
  }

  private stoppedReceipt(trigger: ReminderTrigger): ReminderDeliveryReceipt {
    return {
      delivery_id: `stopped-${trigger.schedule_id}`,
      schedule_id: trigger.schedule_id,
      delivered_at: trigger.triggered_at,
      channels: EMPTY_CHANNELS,
      used_fallback_audio: false,
    };
  }

  private enqueueRebuild(): Promise<readonly ReminderRegistration[]> {
    const generation = this.generation;
    if (!this.isLive(generation)) return Promise.resolve([]);
    return this.enqueueOp(() => this.rebuildInternal(generation));
  }

  private async startInternal(): Promise<void> {
    if (this.started) return;
    this.acceptingWork = true;
    const generation = this.generation;

    try {
      await this.dependencies.recovery.registerForRestart();
      if (!this.isLive(generation)) {
        await this.stopInternal();
        return;
      }

      this.unsubscribePresenter = this.dependencies.presenter.onAction((event) => {
        void this.handlePresentationAction(event.schedule_id, event.action).catch(() => undefined);
      });
      this.unsubscribeAlarms =
        this.dependencies.alarms.subscribe?.((event) => {
          void this.handleNativeAlarmEvent(event).catch(() => undefined);
        }) ?? null;

      // IntervalTimeListener 不在 start 时同步打点；先挂上 listener id 再 rebuild。
      const timeHandle = await this.dependencies.time.start(
        (tick) => {
          void this.handleTime(tick);
        },
        { background: true },
      );
      this.timeListenerId = timeHandle.listener_id;
      if (!this.isLive(generation)) {
        await this.stopInternal();
        return;
      }

      await this.hydrateNativeDispositions(generation);
      if (!this.isLive(generation)) {
        await this.stopInternal();
        return;
      }

      this.unsubscribeSchedules = this.dependencies.schedules.subscribe(() => {
        void this.enqueueRebuild();
      });
      await this.rebuildInternal(generation);
      if (!this.isLive(generation)) {
        await this.stopInternal();
        return;
      }
      this.started = true;
    } catch (error) {
      if (this.isLive(generation)) this.invalidate();
      await this.stopInternal();
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.detachListeners();
    await Promise.allSettled([...this.inFlight]);

    if (this.timeListenerId != null) {
      try {
        await this.dependencies.time.stop(this.timeListenerId);
      } catch {
        // 停机尽力释放时间监听。
      }
      this.timeListenerId = null;
    }

    for (const registration of [...this.registrations.values()]) {
      await this.dropRegistration(registration.schedule_id);
    }
    this.activeDeliveries.clear();
    this.deliverLocks.clear();
    this.nativePresented.clear();
    this.started = false;
  }

  private detachListeners(): void {
    this.unsubscribePresenter?.();
    this.unsubscribePresenter = null;
    this.unsubscribeSchedules?.();
    this.unsubscribeSchedules = null;
    this.unsubscribeAlarms?.();
    this.unsubscribeAlarms = null;
  }

  private async registerInternal(
    schedule: LocalReminderSchedule,
    generation: number,
  ): Promise<ReminderRegistration> {
    const merged = await this.withStoredRuntime(schedule);
    if (!this.isLive(generation) || !this.isSchedulable(merged)) {
      await this.dropRegistration(merged.id);
      return emptyRegistration(merged.id);
    }

    await this.dropRegistration(merged.id);

    const registration: RegistrationRecord = {
      schedule_id: merged.id,
      time_listener_id: this.timeListenerId,
      location_listener_id: null,
      alarm_id: null,
      schedule: merged,
    };
    this.registrations.set(merged.id, registration);

    if (merged.schedule_type === 'location') {
      const handle = await this.watchLocationSchedule(merged);
      registration.location_listener_id = handle?.listener_id ?? null;
    }

    if (merged.schedule_type === 'time') {
      const receipt = await this.scheduleAlarmFor(merged);
      registration.alarm_id = receipt?.scheduled ? receipt.alarm_id : null;
    }

    if (!this.isLive(generation)) {
      await this.dropRegistration(merged.id);
      return emptyRegistration(merged.id);
    }

    return {
      schedule_id: registration.schedule_id,
      time_listener_id: registration.time_listener_id,
      location_listener_id: registration.location_listener_id,
      alarm_id: registration.alarm_id,
    };
  }

  private async rebuildInternal(generation: number): Promise<readonly ReminderRegistration[]> {
    if (!this.isLive(generation)) return [];

    const schedules = await this.dependencies.schedules.listReminderSchedules();
    const active: LocalReminderSchedule[] = [];
    for (const raw of schedules) {
      await this.retryPendingConfirmation(raw);
      const merged = await this.withStoredRuntime(raw);
      if (this.isSchedulable(merged)) {
        active.push(merged);
      }
    }

    if (!this.isLive(generation)) return [];

    for (const registration of [...this.registrations.values()]) {
      await this.dropRegistration(registration.schedule_id);
    }

    if (!this.isLive(generation)) return [];

    // location.rebuild() 会在系统围栏注册完成后立即派发一次当前位置样本。先放入
    // 占位 registration，确保这次初始样本不会因批量重建尚未返回 handle 而被忽略。
    for (const schedule of active) {
      this.registrations.set(schedule.id, {
        schedule_id: schedule.id,
        time_listener_id: this.timeListenerId,
        location_listener_id: null,
        alarm_id: null,
        schedule,
      });
    }

    const locationTargets = active
      .filter((schedule) => schedule.schedule_type === 'location')
      .map((schedule) => {
        const mode = resolveWatchMode(schedule);
        const center = resolveGeofenceCenter(schedule, mode);
        if (center == null) return null;
        return {
          schedule_id: schedule.id,
          center,
          radius_meters: schedule.geofence_radius_meters,
          mode,
          background: true,
        };
      })
      .filter((target): target is NonNullable<typeof target> => target != null);
    const locationHandles = await this.dependencies.location.rebuild(
      locationTargets,
      async (event) => {
        await this.handleLocationMonitorEvent(event);
      },
    );
    const locationBySchedule = new Map<string, LocationWatchHandle>(
      locationHandles.map((handle) => [handle.schedule_id, handle]),
    );

    if (!this.isLive(generation)) {
      await this.discardRebuildResources(locationHandles, []);
      return [];
    }

    for (const schedule of active) {
      this.registrations.set(schedule.id, {
        schedule_id: schedule.id,
        time_listener_id: this.timeListenerId,
        location_listener_id: locationBySchedule.get(schedule.id)?.listener_id ?? null,
        alarm_id: null,
        schedule,
      });
    }

    const alarmRequests = active
      .filter((schedule) => schedule.schedule_type === 'time')
      .map((schedule) => {
        const triggerAt = resolveEffectiveTriggerAt(schedule);
        if (triggerAt == null) return null;
        return {
          schedule_id: schedule.id,
          trigger_at: triggerAt,
          title: schedule.title,
          exact: true,
          ...alarmRingChannels(schedule),
        };
      })
      .filter((request): request is NonNullable<typeof request> => request != null);

    const alarmReceipts = await this.dependencies.alarms.rebuild(alarmRequests);
    const alarmBySchedule = new Map<string, AlarmScheduleReceipt>(
      alarmReceipts.map((receipt) => [receipt.schedule_id, receipt]),
    );

    if (!this.isLive(generation)) {
      for (const receipt of alarmReceipts) {
        if (receipt.scheduled) {
          await this.discardHandles(null, receipt.alarm_id);
        }
      }
      for (const registration of [...this.registrations.values()]) {
        await this.dropRegistration(registration.schedule_id);
      }
      return [];
    }

    const results: ReminderRegistration[] = [];
    for (const schedule of active) {
      const registration = this.registrations.get(schedule.id);
      if (registration == null) continue;
      const alarm = alarmBySchedule.get(schedule.id);
      registration.alarm_id = alarm?.scheduled ? alarm.alarm_id : null;
      results.push({
        schedule_id: registration.schedule_id,
        time_listener_id: registration.time_listener_id,
        location_listener_id: registration.location_listener_id,
        alarm_id: registration.alarm_id,
      });
    }
    return results;
  }

  private async confirmInternal(
    scheduleId: string,
    confirmedAt: string,
    generation: number,
    tolerateSyncFailure = false,
  ): Promise<ReminderApplicationResult> {
    if (!this.isLive(generation)) {
      return { accepted: false, schedule_id: scheduleId, disposition: null };
    }
    try {
      await this.teardownDelivery(scheduleId);

      const disposition: ReminderConfirmedDisposition = {
        schedule_id: scheduleId,
        state: 'confirmed',
        updated_at: confirmedAt,
        snoozed_until: null,
        sync_status: 'pending',
      };
      await this.dependencies.state.setDisposition(scheduleId, disposition);

      const current = (await this.readRuntime(scheduleId)) ?? emptyRuntime();
      await this.patchRuntime(scheduleId, {
        ...current,
        reminder_disposition_state: 'confirmed',
        snoozed_until: null,
        next_trigger_at: null,
        disposition_updated_at: confirmedAt,
        sync_status: 'pending',
      });

      await this.dropRegistration(scheduleId);

      if (!this.isLive(generation)) {
        return { accepted: false, schedule_id: scheduleId, disposition: null };
      }

      const synced = await this.syncConfirmedDisposition(disposition, tolerateSyncFailure);
      return { accepted: true, schedule_id: scheduleId, disposition: synced };
    } finally {
      this.activeDeliveries.delete(scheduleId);
    }
  }

  private async retryPendingConfirmation(schedule: LocalReminderSchedule): Promise<void> {
    const runtime = schedule.runtime;
    if (
      runtime.reminder_disposition_state !== 'confirmed' ||
      runtime.sync_status !== 'pending' ||
      runtime.disposition_updated_at == null
    ) {
      return;
    }
    await this.syncConfirmedDisposition(
      {
        schedule_id: schedule.id,
        state: 'confirmed',
        updated_at: runtime.disposition_updated_at,
        snoozed_until: null,
        sync_status: 'pending',
      },
      true,
    );
  }

  private async syncConfirmedDisposition(
    disposition: ReminderConfirmedDisposition,
    tolerateFailure = false,
  ): Promise<ReminderConfirmedDisposition> {
    try {
      const sync = await this.dependencies.dispositionSync.submitConfirmed(disposition);
      if (!sync.accepted || sync.schedule_id !== disposition.schedule_id) return disposition;

      const synced: ReminderConfirmedDisposition = {
        ...disposition,
        sync_status: 'synced',
      };
      await this.dependencies.state.setDisposition(disposition.schedule_id, synced);
      const runtime = await this.readRuntime(disposition.schedule_id);
      if (runtime != null) {
        await this.patchRuntime(disposition.schedule_id, { ...runtime, sync_status: 'synced' });
      }
      return synced;
    } catch (error) {
      if (!tolerateFailure) throw error;
      return disposition;
    }
  }

  private async snoozeInternal(
    request: ReminderSnoozeRequest,
    generation: number,
  ): Promise<ReminderApplicationResult> {
    if (!this.isLive(generation)) {
      return { accepted: false, schedule_id: request.schedule_id, disposition: null };
    }
    const nowIso = new Date().toISOString();
    const snoozedUntil = resolveSnoozeUntil(nowIso, request.snooze_until, request.snooze_minutes);
    await this.teardownDelivery(request.schedule_id);

    const disposition: ReminderDisposition = {
      schedule_id: request.schedule_id,
      state: 'snoozed',
      updated_at: nowIso,
      snoozed_until: snoozedUntil,
      sync_status: 'pending',
    };
    await this.dependencies.state.setDisposition(request.schedule_id, disposition);

    const current = await this.readRuntime(request.schedule_id);
    const nextRuntime: ReminderRuntimeState = {
      ...(current ?? emptyRuntime()),
      reminder_disposition_state: 'snoozed',
      snoozed_until: snoozedUntil,
      next_trigger_at: snoozedUntil,
      disposition_updated_at: nowIso,
      sync_status: 'pending',
    };
    await this.patchRuntime(request.schedule_id, nextRuntime);

    if (this.isLive(generation)) {
      const raw =
        (await this.dependencies.schedules.getReminderSchedule(request.schedule_id)) ??
        this.registrations.get(request.schedule_id)?.schedule;
      if (raw != null) {
        const schedule = { ...raw, runtime: nextRuntime };
        const previous = this.registrations.get(request.schedule_id);
        if (previous?.alarm_id != null) {
          await this.dependencies.alarms.cancel(previous.alarm_id);
          previous.alarm_id = null;
        }
        const receipt = await this.dependencies.alarms.schedule({
          schedule_id: schedule.id,
          trigger_at: snoozedUntil,
          title: schedule.title,
          exact: true,
          ...alarmRingChannels(schedule),
        });
        if (!this.isLive(generation)) {
          if (receipt.scheduled) {
            await this.dependencies.alarms.cancel(receipt.alarm_id);
          }
        } else {
          const registration = this.registrations.get(request.schedule_id);
          if (registration != null) {
            registration.alarm_id = receipt.scheduled ? receipt.alarm_id : null;
            registration.schedule = schedule;
          } else if (receipt.scheduled) {
            await this.dependencies.alarms.cancel(receipt.alarm_id);
          }
        }
      }
    }

    this.activeDeliveries.delete(request.schedule_id);
    return { accepted: true, schedule_id: request.schedule_id, disposition };
  }

  private async runHandleTime(tick: { observed_at: string }, generation: number): Promise<void> {
    if (!this.isLive(generation)) return;
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    for (const raw of schedules) {
      if (!this.isLive(generation)) return;
      const schedule = await this.withStoredRuntime(raw);
      // 时间型日程只要原生闹钟还接管着（无论是首次触发还是延后重挂），JS 这边
      // 完全不判定、不投递——之前两条通道各自独立判定、靠 activeDeliveries 互斥的
      // 设计里，谁先到点完全看运气：JS 这次 tick 一旦抢先，会在 runDeliver() 里
      // 主动撤销掉本来更可靠的原生闹钟（见 cancelScheduledAlarm），退化成通知/震动
      // 这种更容易被用户忽略的投递方式。原生已经接管的日程直接跳过，消除这个竞态。
      if (
        schedule.schedule_type === 'time' &&
        this.registrations.get(schedule.id)?.alarm_id != null
      ) {
        continue;
      }
      if (!(await this.canDeliver(schedule, tick.observed_at, generation))) continue;

      if (isSnoozeExpired(schedule, tick.observed_at)) {
        await this.deliverOne(
          this.buildTrigger(schedule, 'snooze_expired', tick.observed_at),
          generation,
        );
        continue;
      }

      if (isTimeWindowReached(schedule, tick.observed_at)) {
        const reason = toTimeReason(schedule);
        await this.deliverOne(this.buildTrigger(schedule, reason, tick.observed_at), generation);
      }
    }
    await this.runStuckPendingRescue(schedules, tick.observed_at, generation);
  }

  /**
   * 卡在 pending 超过 STUCK_PENDING_THRESHOLD_MS 还没被确认/延后，当成"响了但没
   * 送达"补一次——不管这条 pending 是本会话的 runDeliver/acknowledgeNativeFire 落的，
   * 还是跨会话遗留的，一律按同一个阈值处理。不用 activeDeliveries 做区分：只要还
   * pending 就一直有这条 id 在里面，分不出"真的在正常展示"还是"其实原生没展示
   * 成功"——presentNow() 无论展示成不成功都会 resolve(true)，两者目前没有任何
   * 独立信号能区分开。
   *
   * 这是 reminderGuardTask.ts 里 runStuckPendingPass 的会话存活版本：那份只在
   * listeners.size === 0（会话已死）时才跑，而前台保活的目的正是让会话不死，
   * 两份合起来才覆盖"会话存活"和"会话已死"两种场景，缺一个都有盲区。
   */
  private async runStuckPendingRescue(
    schedules: readonly LocalReminderSchedule[],
    observedAt: string,
    generation: number,
  ): Promise<void> {
    const nowMs = Date.parse(observedAt);
    for (const raw of schedules) {
      if (!this.isLive(generation)) return;
      if (raw.status !== 'active') continue;
      if (this.deliverLocks.has(raw.id)) continue;

      const runtime = await this.readRuntime(raw.id);
      if (runtime?.reminder_disposition_state !== 'pending') continue;
      const staleAt = runtime.disposition_updated_at;
      const updatedMs = staleAt == null ? NaN : Date.parse(staleAt);
      if (Number.isNaN(updatedMs) || nowMs - updatedMs < STUCK_PENDING_THRESHOLD_MS) continue;

      // confirm()/snooze() 走独立的 opChain，跟这个 30s tick（track()）之间没有共享
      // 锁——触发前再读一次，disposition_updated_at 变了说明这段时间被 confirm/
      // snooze 抢先处理了，放弃这次补弹，避免把刚确认完的提醒又弹回来。
      if (this.deliverLocks.has(raw.id)) continue;
      const recheck = await this.readRuntime(raw.id);
      if (
        recheck?.reminder_disposition_state !== 'pending' ||
        recheck.disposition_updated_at !== staleAt
      ) {
        continue;
      }

      const schedule: LocalReminderSchedule = { ...raw, runtime: recheck };
      await this.deliverOne(this.buildTrigger(schedule, 'stuck_pending', observedAt), generation);
    }
  }

  private async runHandleLocation(sample: LocationSample, generation: number): Promise<void> {
    if (!this.isLive(generation)) return;
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    for (const raw of schedules) {
      if (!this.isLive(generation)) return;
      const schedule = await this.withStoredRuntime(raw);
      if (schedule.schedule_type !== 'location') continue;
      await this.applyLocationSample(schedule, sample, generation);
    }
  }

  private async runDeliver(
    trigger: ReminderTrigger,
    generation: number,
  ): Promise<ReminderDeliveryReceipt> {
    if (!this.isLive(generation)) return this.stoppedReceipt(trigger);
    if (this.deliverLocks.has(trigger.schedule_id)) {
      return {
        delivery_id: `inflight-${trigger.schedule_id}`,
        schedule_id: trigger.schedule_id,
        delivered_at: trigger.triggered_at,
        channels: EMPTY_CHANNELS,
        used_fallback_audio: false,
      };
    }
    this.deliverLocks.add(trigger.schedule_id);
    this.activeDeliveries.add(trigger.schedule_id);

    try {
      const raw =
        (await this.dependencies.schedules.getReminderSchedule(trigger.schedule_id)) ??
        this.registrations.get(trigger.schedule_id)?.schedule;
      if (raw == null) {
        return {
          delivery_id: `missing-${trigger.schedule_id}`,
          schedule_id: trigger.schedule_id,
          delivered_at: trigger.triggered_at,
          channels: EMPTY_CHANNELS,
          used_fallback_audio: false,
        };
      }

      const schedule = await this.withStoredRuntime(raw);
      const previousRuntime = schedule.runtime;
      // 围栏触发已 disarm：失败回滚时保留 armed=false，逼迫重新 leave→arm→enter。
      const rollbackRuntime: ReminderRuntimeState = {
        ...previousRuntime,
        geofence_armed:
          schedule.schedule_type === 'location' ? false : previousRuntime.geofence_armed,
        reminder_disposition_state:
          previousRuntime.reminder_disposition_state === 'pending'
            ? null
            : previousRuntime.reminder_disposition_state,
      };

      try {
        if (!this.isLive(generation)) return this.stoppedReceipt(trigger);
        await this.patchRuntime(schedule.id, {
          ...schedule.runtime,
          reminder_disposition_state: 'pending',
          next_trigger_at: null,
          disposition_updated_at: trigger.triggered_at,
          sync_status: 'pending',
        });

        const request = toDeliveryRequest(schedule, trigger);
        const plan = resolveStrengthDeliveryPlan(request.strength);
        const channels: DeliveryChannel[] = [];
        let usedFallbackAudio = false;
        let deliveryId = `delivery-${schedule.id}`;

        // 原生全屏响铃页统一优先：时间型日程走到这里，说明原生闹钟本来就没能
        // 挂上（挂上了的日程 runHandleTime 已经整条跳过，不会再进 runDeliver）；
        // 地点型没有原生闹钟等价物，一律靠这里的 presentNow。两种类型不再区分
        // 对待，全部强度都要全屏，不再有"低强度只发一条普通通知"这条路——只有
        // presentNow 本身不可用（iOS、原生模块拿不到）时才回退到下面的 JS 通道。
        let presentedNatively = false;
        if (this.dependencies.alarms.presentNow != null) {
          const speechText = composeReminderSpeech(schedule);
          // 诊断用：presentNow 这条兜底路径算出来的语音文案——定位问题排查完可以删。
          console.warn(
            '[reminder] presentNow speech_text',
            schedule.id,
            schedule.title,
            'strength=',
            schedule.reminder?.reminder_strength,
            'speech_text=',
            speechText,
          );
          const nativeReceipt = await this.dependencies.alarms.presentNow({
            alarm_id: `present-${schedule.id}-${Date.now()}`,
            schedule_id: schedule.id,
            title: schedule.title,
            vibrate: plan.useVibration,
            sound_tier: plan.alarmSoundTier,
            full_screen: true,
            speech_text: speechText,
          });
          if (nativeReceipt.presented) {
            presentedNatively = true;
            deliveryId = `native-${nativeReceipt.alarm_id}`;
            channels.push('native_full_screen');
          }
        }

        let audioPlayed = false;
        if (!presentedNatively) {
          // low=系统通知；medium=弹窗+短震动；high=弹窗+短震动+TTS（失败则本地音）。
          if (plan.useSystemNotification) {
            const receipt = await this.dependencies.delivery.deliver(request);
            deliveryId = receipt.delivery_id;
            await this.dependencies.systemNotification.show({
              notification_id: `reminder-${schedule.id}`,
              title: schedule.title,
              body: schedule.location_name ?? schedule.title,
            });
            channels.push('system_notification');
          }

          if (plan.usePopup) {
            await this.dependencies.presenter.show(request);
            channels.push('popup');
          }

          if (plan.useVibration) {
            await this.dependencies.vibration.vibrate();
            channels.push('vibration');
          }

          if (plan.useAudio) {
            let audioReceipt = await this.dependencies.audio.playTts({ schedule_id: schedule.id });
            if (!audioReceipt.played) {
              audioReceipt = await this.dependencies.audio.playLocalFallback({
                schedule_id: schedule.id,
              });
            }
            audioPlayed = audioReceipt.played;
            if (audioPlayed) {
              channels.push(audioReceipt.used_local_fallback ? 'local_sound' : 'tts');
            }
            usedFallbackAudio = audioReceipt.used_local_fallback;
          }

          await this.cancelScheduledAlarm(schedule.id);
          if (!plan.useAudio || audioPlayed) {
            await this.dependencies.alarms.stopRinging?.();
          }
        }

        if (!this.isLive(generation)) {
          if (!this.acceptingWork) {
            await this.patchRuntime(schedule.id, rollbackRuntime);
            await this.teardownDelivery(schedule.id);
          }
          return this.stoppedReceipt(trigger);
        }

        return {
          delivery_id: deliveryId,
          schedule_id: schedule.id,
          delivered_at: trigger.triggered_at,
          channels,
          used_fallback_audio: usedFallbackAudio,
        };
      } catch (error) {
        if (!this.acceptingWork || this.isLive(generation)) {
          await this.patchRuntime(schedule.id, rollbackRuntime);
          await this.teardownDelivery(schedule.id);
        }
        throw error;
      }
    } finally {
      this.deliverLocks.delete(trigger.schedule_id);
      // 成功送达保持 activeDeliveries直至 confirm/snooze；失败则释放以便可重试。
      const runtime = await this.readRuntime(trigger.schedule_id);
      if (runtime?.reminder_disposition_state !== 'pending') {
        this.activeDeliveries.delete(trigger.schedule_id);
      }
    }
  }

  private async deliverOne(trigger: ReminderTrigger, generation: number): Promise<void> {
    try {
      await this.track(this.runDeliver(trigger, generation));
    } catch {
      // 单条送达失败不阻断其余日程。
    }
  }

  private async handlePresentationAction(
    scheduleId: string,
    action: 'confirm' | 'snooze',
  ): Promise<void> {
    const generation = this.generation;
    if (!this.isLive(generation)) return;
    if (action === 'confirm') {
      await this.enqueueOp(() =>
        this.confirmInternal(scheduleId, new Date().toISOString(), generation),
      );
      return;
    }
    await this.enqueueOp(() =>
      this.snoozeInternal(
        { schedule_id: scheduleId, snooze_until: null, snooze_minutes: DEFAULT_SNOOZE_MINUTES },
        generation,
      ),
    );
  }

  private async handleNativeAlarmEvent(event: AlarmNativeEvent): Promise<void> {
    if (!event.schedule_id) return;
    if (event.type === 'fired') {
      await this.acknowledgeNativeFire(event.schedule_id, event.at);
      return;
    }
    if (event.type === 'snoozed') {
      await this.snooze({ schedule_id: event.schedule_id, snooze_until: null });
      return;
    }
    await this.confirm(event.schedule_id, event.at);
  }

  /**
   * 原生已承接响铃 UI：只落 pending disposition，避免 JS 再弹 Alert/TTS。
   * handleTime 会因 pending / activeDeliveries 跳过，从而消除双通道连响。
   */
  private async acknowledgeNativeFire(scheduleId: string, firedAt: string): Promise<void> {
    // handleTime 侧的 canDeliver() 检查 activeDeliveries 来跳过已经在原生响铃的日程，
    // 但反过来这里原来只看持久化的 disposition_state——如果 handleTime 已经在跑（还没
    // 来得及落盘 pending）而原生这时候也报了 fired，两条通道会一起响。加上这个检查堵住。
    if (this.activeDeliveries.has(scheduleId)) {
      this.nativePresented.add(scheduleId);
      return;
    }
    const runtime = (await this.readRuntime(scheduleId)) ?? emptyRuntime();
    if (
      runtime.reminder_disposition_state === 'confirmed' ||
      runtime.reminder_disposition_state === 'pending'
    ) {
      this.nativePresented.add(scheduleId);
      this.activeDeliveries.add(scheduleId);
      return;
    }

    this.nativePresented.add(scheduleId);
    this.activeDeliveries.add(scheduleId);
    await this.cancelScheduledAlarm(scheduleId);
    await this.patchRuntime(scheduleId, {
      ...runtime,
      reminder_disposition_state: 'pending',
      next_trigger_at: null,
      disposition_updated_at: firedAt,
      sync_status: 'pending',
    });
    await this.dependencies.state.setDisposition(scheduleId, {
      schedule_id: scheduleId,
      state: 'pending',
      updated_at: firedAt,
      snoozed_until: null,
      sync_status: 'pending',
    });
  }

  /**
   * 只能在 startInternal() 内部调用：这本身就是 opChain 上正在跑的那个任务，
   * 这里必须直接调 confirmInternal/snoozeInternal（不再入队），否则通过公开的
   * confirm()/snooze() 会把新任务追加到同一条 opChain 上，而那条链要等
   * startInternal()（也就是当前这次调用本身）先跑完才会轮到它们——形成死锁,
   * 冷启动永远卡在这一步。
   */
  private async hydrateNativeDispositions(generation: number): Promise<void> {
    const rows = await this.dependencies.alarms.peekNativeDispositions?.();
    if (rows == null || rows.length === 0) return;

    for (const row of rows) {
      if (row.state === 'confirmed') {
        await this.confirmInternal(row.schedule_id, row.updated_at, generation, true);
        continue;
      }
      if (row.state === 'snoozed') {
        await this.snoozeInternal({ schedule_id: row.schedule_id, snooze_until: null }, generation);
        continue;
      }
      await this.acknowledgeNativeFire(row.schedule_id, row.updated_at);
    }
    // ack 放在整批落盘都成功之后：peek 不清空原生缓冲区，中途某一条抛错就整批
    // 不 ack，下次冷启动重新 peek 到、重放同样的 confirm/snooze/acknowledgeNativeFire
    // ——这几个都是幂等的状态转换，重放安全，比"读完立刻清空"丢数据的窗口好。
    await this.dependencies.alarms.ackNativeDispositions?.(rows.map((row) => row.schedule_id));
  }

  private async cancelScheduledAlarm(scheduleId: string): Promise<void> {
    const registration = this.registrations.get(scheduleId);
    if (registration?.alarm_id == null) return;
    await this.dependencies.alarms.cancel(registration.alarm_id);
    registration.alarm_id = null;
  }

  private async handleLocationMonitorEvent(event: LocationMonitorEvent): Promise<void> {
    const generation = this.generation;
    await this.track(this.runLocationMonitorEvent(event, generation));
  }

  private async runLocationMonitorEvent(
    event: LocationMonitorEvent,
    generation: number,
  ): Promise<void> {
    if (!this.isLive(generation)) return;
    if (!this.registrations.has(event.schedule_id)) return;
    const raw =
      (await this.dependencies.schedules.getReminderSchedule(event.schedule_id)) ??
      this.registrations.get(event.schedule_id)?.schedule;
    if (raw == null) return;
    if (!this.isLive(generation)) return;
    const schedule = await this.withStoredRuntime(raw);
    if (schedule.schedule_type !== 'location') return;
    await this.applyLocationSample(schedule, event.sample, generation);
  }

  private async applyLocationSample(
    schedule: LocalReminderSchedule,
    sample: LocationSample,
    generation: number,
  ): Promise<void> {
    if (!this.isLive(generation)) return;
    const canDeliver = await this.canDeliver(schedule, sample.observed_at, generation);
    // 诊断用：canDeliver 为 false 会直接 return，evaluateGeofence 根本不会跑——
    // 之前排查"进圈没反应"如果卡在这一步，日志上只会看到这一行、看不到距离/
    // transition，就是这里拦住了。定位问题排查完可以删。
    console.warn(
      '[reminder] applyLocationSample',
      schedule.id,
      schedule.title,
      'canDeliver=',
      canDeliver,
      'disposition=',
      schedule.runtime.reminder_disposition_state,
    );
    if (!canDeliver) return;

    const mode = resolveWatchMode(schedule);
    const center = resolveGeofenceCenter(schedule, mode);
    const transition = evaluateGeofence(schedule, sample, mode);
    console.warn(
      '[reminder] geofence eval',
      schedule.id,
      schedule.title,
      'distance=',
      center == null ? 'no-center' : Math.round(distanceMeters(sample, center)),
      'radius=',
      schedule.geofence_radius_meters,
      'was_armed=',
      schedule.runtime.geofence_armed,
      'transition=',
      transition,
    );
    if (transition === 'armed') {
      if (!this.isLive(generation)) return;
      await this.patchRuntime(schedule.id, {
        ...schedule.runtime,
        geofence_armed: true,
      });
      return;
    }
    if (transition === 'triggered') {
      if (!this.isLive(generation)) return;
      console.warn('[reminder] TRIGGERED, delivering', schedule.id, schedule.title);
      // 先消耗边沿（disarm），再送达；失败也不恢复 armed，避免圈内连响。
      await this.patchRuntime(schedule.id, {
        ...schedule.runtime,
        geofence_armed: false,
      });
      const reason = toLocationReason(schedule);
      await this.deliverOne(this.buildTrigger(schedule, reason, sample.observed_at), generation);
    }
  }

  private async dropRegistration(scheduleId: string): Promise<void> {
    const existing = this.registrations.get(scheduleId);
    if (existing == null) return;
    this.registrations.delete(scheduleId);
    await this.discardHandles(existing.location_listener_id, existing.alarm_id);
  }

  private async discardHandles(
    locationListenerId: string | null,
    alarmId: string | null,
  ): Promise<void> {
    if (locationListenerId != null) {
      try {
        await this.dependencies.location.unwatch(locationListenerId);
      } catch {
        // 尽力取消围栏监听。
      }
    }
    if (alarmId != null) {
      try {
        await this.dependencies.alarms.cancel(alarmId);
      } catch {
        // 尽力取消系统闹钟。
      }
    }
  }

  private async discardRebuildResources(
    locationHandles: readonly LocationWatchHandle[],
    alarmReceipts: readonly AlarmScheduleReceipt[],
  ): Promise<void> {
    for (const handle of locationHandles) {
      await this.discardHandles(handle.listener_id, null);
    }
    for (const receipt of alarmReceipts) {
      if (receipt.scheduled) {
        await this.discardHandles(null, receipt.alarm_id);
      }
    }
  }

  private isSchedulable(schedule: LocalReminderSchedule): boolean {
    if (schedule.status !== 'active') return false;
    if (schedule.runtime.reminder_disposition_state === 'confirmed') return false;
    return true;
  }

  private async canDeliver(
    schedule: LocalReminderSchedule,
    nowIso: string,
    generation: number,
  ): Promise<boolean> {
    if (!this.isLive(generation)) return false;
    if (schedule.status !== 'active') return false;
    if (this.activeDeliveries.has(schedule.id)) return false;
    if (this.deliverLocks.has(schedule.id)) return false;

    const runtime = (await this.readRuntime(schedule.id)) ?? schedule.runtime;
    if (runtime.reminder_disposition_state === 'confirmed') return false;
    if (runtime.reminder_disposition_state === 'pending') return false;
    if (isSnoozeActive({ ...schedule, runtime }, nowIso)) return false;
    return true;
  }

  private async teardownDelivery(scheduleId: string): Promise<void> {
    const tasks = [
      () => this.dependencies.presenter.hide(scheduleId),
      () => this.dependencies.delivery.dismiss(scheduleId),
      () => this.dependencies.audio.stop(scheduleId),
      () => this.dependencies.vibration.stop(),
      () => this.dependencies.popup.dismiss(`reminder-${scheduleId}`),
      () => this.dependencies.systemNotification.cancel(`reminder-${scheduleId}`),
    ];
    for (const task of tasks) {
      try {
        await task();
      } catch {
        // 尽力拆掉已启动通道，单个失败不阻断其余通道。
      }
    }
  }

  private async watchLocationSchedule(
    schedule: LocalReminderSchedule,
  ): Promise<LocationWatchHandle | null> {
    const mode = resolveWatchMode(schedule);
    const center = resolveGeofenceCenter(schedule, mode);
    if (center == null) return null;
    const handle = await this.dependencies.location.watch(
      {
        schedule_id: schedule.id,
        center,
        radius_meters: schedule.geofence_radius_meters,
        mode,
        background: true,
      },
      async (event) => {
        await this.handleLocationMonitorEvent(event);
      },
    );
    void this.reportPermissionGaps(schedule.id, ['location_foreground', 'location_background']);
    return handle;
  }

  private async scheduleAlarmFor(
    schedule: LocalReminderSchedule,
  ): Promise<AlarmScheduleReceipt | null> {
    const triggerAt = resolveEffectiveTriggerAt(schedule);
    if (triggerAt == null) return null;
    const receipt = await this.dependencies.alarms.schedule({
      schedule_id: schedule.id,
      trigger_at: triggerAt,
      title: schedule.title,
      exact: true,
      ...alarmRingChannels(schedule),
    });
    void this.reportPermissionGaps(schedule.id, [
      'exact_alarm',
      'overlay',
      'full_screen',
      'battery_optimization',
      'notifications',
    ]);
    return receipt;
  }

  /**
   * 单条日程刚注册完，读一遍当前权限状态，把这条日程依赖、但还没给的权限报给
   * 展示层。只在增量注册（registerInternal）路径调用，不在批量 rebuild 里调，
   * 否则每次 rebuild（比如别的权限刚被授予触发的那次）都会给老日程重弹一遍。
   */
  private async reportPermissionGaps(
    scheduleId: string,
    permissions: readonly DevicePermission[],
  ): Promise<void> {
    const status = await this.dependencies.device.getStatus();
    if (status.platform !== 'android') return;
    const missing = permissions.filter((permission) => !status.permissions[permission]);
    if (missing.length === 0) return;
    for (const listener of this.permissionBlockedListeners) {
      listener({ schedule_id: scheduleId, missing });
    }
  }

  private buildTrigger(
    schedule: LocalReminderSchedule,
    reason: ReminderTriggerReason,
    triggeredAt: string,
  ): ReminderTrigger {
    return {
      reminder_id: `reminder-${schedule.id}`,
      schedule_id: schedule.id,
      reason,
      triggered_at: triggeredAt,
    };
  }

  private async withStoredRuntime(schedule: LocalReminderSchedule): Promise<LocalReminderSchedule> {
    const stored = await this.readRuntime(schedule.id);
    if (stored == null) return schedule;
    return { ...schedule, runtime: stored };
  }

  private async readRuntime(scheduleId: string): Promise<ReminderRuntimeState | null> {
    return this.dependencies.state.read(scheduleId);
  }

  private async patchRuntime(scheduleId: string, state: ReminderRuntimeState): Promise<void> {
    await this.dependencies.state.write(scheduleId, state);
    const registration = this.registrations.get(scheduleId);
    if (registration != null) {
      registration.schedule = {
        ...registration.schedule,
        runtime: state,
      };
    }
  }
}

function toDeliveryRequest(
  schedule: LocalReminderSchedule,
  trigger: ReminderTrigger,
): ReminderDeliveryRequest {
  return {
    reminder_id: trigger.reminder_id,
    schedule_id: schedule.id,
    title: schedule.title,
    strength: schedule.reminder?.reminder_strength ?? 'medium',
    trigger,
  };
}

/**
 * 原生闹钟响铃时要不要震动/弹全屏止铃界面、声音走哪个档位。全屏恒为真（时间型
 * 提醒没有别的可见形式，静音也得让用户看到），vibrate/soundTier 复用 JS 侧的
 * 强度换算表：低=一声提示音不震动、中=一声提示音+震动、高=循环语音+震动。
 */
function alarmRingChannels(schedule: LocalReminderSchedule): {
  vibrate: boolean;
  sound_tier: AlarmSoundTier;
  full_screen: boolean;
  speech_text: string;
} {
  const plan = resolveStrengthDeliveryPlan(schedule.reminder?.reminder_strength ?? 'medium');
  const speechText = composeReminderSpeech(schedule);
  // 诊断用：确认排闹钟这一刻算出来的强度/声音档位/语音文案到底是什么——如果
  // strength 不是 'high' 或者 speech_text 是空串，原生那边不可能念 TTS，问题
  // 就出在这一步而不是原生。定位问题排查完可以删。
  console.warn(
    '[reminder] alarmRingChannels',
    schedule.id,
    schedule.title,
    'strength=',
    schedule.reminder?.reminder_strength,
    'sound_tier=',
    plan.alarmSoundTier,
    'speech_text=',
    speechText,
  );
  return {
    vibrate: plan.useVibration,
    sound_tier: plan.alarmSoundTier,
    full_screen: true,
    speech_text: speechText,
  };
}

function toTimeReason(schedule: LocalReminderSchedule): ReminderTriggerReason {
  return schedule.reminder?.reminder_type === 'before_start' ? 'before_start' : 'at_time';
}

function toLocationReason(schedule: LocalReminderSchedule): ReminderTriggerReason {
  return schedule.reminder?.reminder_type === 'return_to_recorded_location'
    ? 'return_to_recorded_location'
    : 'arrive_location';
}

function emptyRuntime(): ReminderRuntimeState {
  return {
    reminder_disposition_state: null,
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: false,
    disposition_updated_at: null,
    sync_status: 'pending',
    recorded_location: null,
  };
}
