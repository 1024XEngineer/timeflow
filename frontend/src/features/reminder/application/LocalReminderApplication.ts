import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
  ReminderApplicationResult,
  ReminderConfirmedDisposition,
  ReminderSnoozeRequest,
  LocationMonitorEvent,
  LocationWatchHandle,
  AlarmScheduleReceipt,
} from './interfaces';
import type {
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
import { evaluateGeofence, resolveGeofenceCenter, resolveWatchMode } from '../domain/geofence';
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
  private readonly registrations = new Map<string, RegistrationRecord>();
  private readonly activeDeliveries = new Set<string>();
  private readonly deliverLocks = new Set<string>();
  private opChain: Promise<void> = Promise.resolve();
  private stopRequested = false;

  constructor(readonly dependencies: ReminderApplicationDependencies) {}

  async start(): Promise<void> {
    return this.enqueueOp(() => this.startInternal());
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.detachListeners();
    return this.enqueueOp(() => this.stopInternal());
  }

  async register(schedule: LocalReminderSchedule): Promise<ReminderRegistration> {
    return this.enqueueOp(() => this.registerInternal(schedule));
  }

  async rebuild(): Promise<readonly ReminderRegistration[]> {
    return this.enqueueRebuild();
  }

  async handleTime(tick: { observed_at: string }): Promise<void> {
    if (this.stopRequested) return;
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    for (const raw of schedules) {
      if (this.stopRequested) return;
      const schedule = await this.withStoredRuntime(raw);
      if (!(await this.canDeliver(schedule, tick.observed_at))) continue;

      if (isSnoozeExpired(schedule, tick.observed_at)) {
        await this.deliverOne(this.buildTrigger(schedule, 'snooze_expired', tick.observed_at));
        continue;
      }

      if (isTimeWindowReached(schedule, tick.observed_at)) {
        const reason = toTimeReason(schedule);
        await this.deliverOne(this.buildTrigger(schedule, reason, tick.observed_at));
      }
    }
  }

  async handleLocation(sample: LocationSample): Promise<void> {
    if (this.stopRequested) return;
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    for (const raw of schedules) {
      if (this.stopRequested) return;
      const schedule = await this.withStoredRuntime(raw);
      if (schedule.schedule_type !== 'location') continue;
      await this.applyLocationSample(schedule, sample);
    }
  }

  async deliver(trigger: ReminderTrigger): Promise<ReminderDeliveryReceipt> {
    if (this.stopRequested) {
      return {
        delivery_id: `stopped-${trigger.schedule_id}`,
        schedule_id: trigger.schedule_id,
        delivered_at: trigger.triggered_at,
        channels: EMPTY_CHANNELS,
        used_fallback_audio: false,
      };
    }
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
        if (this.stopRequested) {
          return {
            delivery_id: `stopped-${trigger.schedule_id}`,
            schedule_id: trigger.schedule_id,
            delivered_at: trigger.triggered_at,
            channels: EMPTY_CHANNELS,
            used_fallback_audio: false,
          };
        }
        await this.patchRuntime(schedule.id, {
          ...schedule.runtime,
          reminder_disposition_state: 'pending',
          next_trigger_at: null,
          disposition_updated_at: trigger.triggered_at,
          sync_status: 'pending',
        });

        const request = toDeliveryRequest(schedule, trigger);
        const receipt = await this.dependencies.delivery.deliver(request);
        await this.dependencies.presenter.show(request);
        await this.dependencies.systemNotification.show({
          notification_id: `reminder-${schedule.id}`,
          title: schedule.title,
          body: schedule.location_name ?? schedule.title,
        });
        await this.dependencies.popup.show({
          popup_id: `reminder-${schedule.id}`,
          title: schedule.title,
          body: schedule.location_name ?? schedule.title,
        });
        await this.dependencies.vibration.vibrate();

        let audioReceipt = await this.dependencies.audio.playTts({ schedule_id: schedule.id });
        if (!audioReceipt.played) {
          audioReceipt = await this.dependencies.audio.playLocalFallback({
            schedule_id: schedule.id,
          });
        }

        if (this.stopRequested) {
          await this.patchRuntime(schedule.id, rollbackRuntime);
          await this.teardownDelivery(schedule.id);
          return {
            delivery_id: `stopped-${trigger.schedule_id}`,
            schedule_id: trigger.schedule_id,
            delivered_at: trigger.triggered_at,
            channels: EMPTY_CHANNELS,
            used_fallback_audio: false,
          };
        }

        return {
          ...receipt,
          channels: [
            ...receipt.channels,
            'popup',
            'vibration',
            audioReceipt.used_local_fallback ? 'local_sound' : 'tts',
          ],
          used_fallback_audio: audioReceipt.used_local_fallback,
        };
      } catch (error) {
        await this.patchRuntime(schedule.id, rollbackRuntime);
        await this.teardownDelivery(schedule.id);
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

  async confirm(scheduleId: string, confirmedAt: string): Promise<ReminderApplicationResult> {
    return this.enqueueOp(() => this.confirmInternal(scheduleId, confirmedAt));
  }

  async snooze(request: ReminderSnoozeRequest): Promise<ReminderApplicationResult> {
    return this.enqueueOp(() => this.snoozeInternal(request));
  }

  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueueRebuild(): Promise<readonly ReminderRegistration[]> {
    if (this.stopRequested) return Promise.resolve([]);
    return this.enqueueOp(() => this.rebuildInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.started) return;
    this.stopRequested = false;

    try {
      await this.dependencies.recovery.registerForRestart();
      if (this.stopRequested) {
        await this.stopInternal();
        return;
      }

      this.unsubscribePresenter = this.dependencies.presenter.onAction((event) => {
        void this.handlePresentationAction(event.schedule_id, event.action);
      });

      // IntervalTimeListener 不在 start 时同步打点；先挂上 listener id 再 rebuild。
      const timeHandle = await this.dependencies.time.start(
        (tick) => {
          void this.handleTime(tick);
        },
        { background: true },
      );
      this.timeListenerId = timeHandle.listener_id;
      if (this.stopRequested) {
        await this.stopInternal();
        return;
      }

      this.unsubscribeSchedules = this.dependencies.schedules.subscribe(() => {
        void this.enqueueRebuild();
      });
      await this.rebuildInternal();
      if (this.stopRequested) {
        await this.stopInternal();
        return;
      }
      this.started = true;
    } catch (error) {
      const stopping = this.stopRequested;
      this.stopRequested = true;
      await this.stopInternal();
      if (!stopping) this.stopRequested = false;
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.detachListeners();

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
    this.started = false;
  }

  private detachListeners(): void {
    this.unsubscribePresenter?.();
    this.unsubscribePresenter = null;
    this.unsubscribeSchedules?.();
    this.unsubscribeSchedules = null;
  }

  private async registerInternal(schedule: LocalReminderSchedule): Promise<ReminderRegistration> {
    const merged = await this.withStoredRuntime(schedule);
    if (this.stopRequested || !this.isSchedulable(merged)) {
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

    if (this.stopRequested) {
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

  private async rebuildInternal(): Promise<readonly ReminderRegistration[]> {
    if (this.stopRequested) return [];

    const schedules = await this.dependencies.schedules.listReminderSchedules();
    const active: LocalReminderSchedule[] = [];
    for (const raw of schedules) {
      const merged = await this.withStoredRuntime(raw);
      if (this.isSchedulable(merged)) {
        active.push(merged);
      }
    }

    if (this.stopRequested) return [];

    for (const registration of [...this.registrations.values()]) {
      await this.dropRegistration(registration.schedule_id);
    }

    if (this.stopRequested) return [];

    const locationSchedules = active.filter((schedule) => schedule.schedule_type === 'location');
    const locationHandles = await this.dependencies.location.rebuild(locationSchedules, (event) => {
      void this.handleLocationMonitorEvent(event);
    });
    const locationBySchedule = new Map<string, LocationWatchHandle>(
      locationHandles.map((handle) => [handle.schedule_id, handle]),
    );

    if (this.stopRequested) {
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
        };
      })
      .filter((request): request is NonNullable<typeof request> => request != null);

    const alarmReceipts = await this.dependencies.alarms.rebuild(alarmRequests);
    const alarmBySchedule = new Map<string, AlarmScheduleReceipt>(
      alarmReceipts.map((receipt) => [receipt.schedule_id, receipt]),
    );

    if (this.stopRequested) {
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
  ): Promise<ReminderApplicationResult> {
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

    const sync = await this.dependencies.dispositionSync.submitConfirmed(disposition);
    const synced: ReminderDisposition = {
      ...disposition,
      sync_status: sync.accepted ? 'synced' : 'pending',
    };
    if (sync.accepted) {
      await this.dependencies.state.setDisposition(scheduleId, synced);
      const runtime = await this.readRuntime(scheduleId);
      if (runtime != null) {
        await this.patchRuntime(scheduleId, { ...runtime, sync_status: 'synced' });
      }
    }

    this.activeDeliveries.delete(scheduleId);
    return { accepted: true, schedule_id: scheduleId, disposition: synced };
  }

  private async snoozeInternal(request: ReminderSnoozeRequest): Promise<ReminderApplicationResult> {
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

    if (!this.stopRequested) {
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
        });
        if (this.stopRequested) {
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

  private async deliverOne(trigger: ReminderTrigger): Promise<void> {
    try {
      await this.deliver(trigger);
    } catch {
      // 单条送达失败不阻断其余日程。
    }
  }

  private async handlePresentationAction(
    scheduleId: string,
    action: 'confirm' | 'snooze',
  ): Promise<void> {
    if (action === 'confirm') {
      await this.confirm(scheduleId, new Date().toISOString());
      return;
    }
    await this.snooze({ schedule_id: scheduleId, snooze_minutes: DEFAULT_SNOOZE_MINUTES });
  }

  private async handleLocationMonitorEvent(event: LocationMonitorEvent): Promise<void> {
    if (this.stopRequested) return;
    if (!this.registrations.has(event.schedule_id)) return;
    const raw =
      (await this.dependencies.schedules.getReminderSchedule(event.schedule_id)) ??
      this.registrations.get(event.schedule_id)?.schedule;
    if (raw == null) return;
    const schedule = await this.withStoredRuntime(raw);
    if (schedule.schedule_type !== 'location') return;
    await this.applyLocationSample(schedule, event.sample);
  }

  private async applyLocationSample(
    schedule: LocalReminderSchedule,
    sample: LocationSample,
  ): Promise<void> {
    if (this.stopRequested) return;
    if (!(await this.canDeliver(schedule, sample.observed_at))) return;

    const mode = resolveWatchMode(schedule);
    const transition = evaluateGeofence(schedule, sample, mode);
    if (transition === 'armed') {
      await this.patchRuntime(schedule.id, {
        ...schedule.runtime,
        geofence_armed: true,
      });
      return;
    }
    if (transition === 'triggered') {
      // 先消耗边沿（disarm），再送达；失败也不恢复 armed，避免圈内连响。
      await this.patchRuntime(schedule.id, {
        ...schedule.runtime,
        geofence_armed: false,
      });
      const reason = toLocationReason(schedule);
      await this.deliverOne(this.buildTrigger(schedule, reason, sample.observed_at));
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

  private async canDeliver(schedule: LocalReminderSchedule, nowIso: string): Promise<boolean> {
    if (this.stopRequested) return false;
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
    return this.dependencies.location.watch(
      {
        schedule_id: schedule.id,
        center,
        radius_meters: schedule.geofence_radius_meters,
        mode,
        background: true,
      },
      (event) => {
        void this.handleLocationMonitorEvent(event);
      },
    );
  }

  private async scheduleAlarmFor(
    schedule: LocalReminderSchedule,
  ): Promise<AlarmScheduleReceipt | null> {
    const triggerAt = resolveEffectiveTriggerAt(schedule);
    if (triggerAt == null) return null;
    return this.dependencies.alarms.schedule({
      schedule_id: schedule.id,
      trigger_at: triggerAt,
      title: schedule.title,
      exact: true,
    });
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
