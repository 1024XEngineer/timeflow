import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
  ReminderApplicationResult,
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

/** 本地提醒协调器：通过已注入端口完成注册、触发、送达与确认/延后。 */
export class LocalReminderApplication implements ReminderApplicationPort {
  private started = false;
  private timeListenerId: string | null = null;
  private unsubscribePresenter: (() => void) | null = null;
  private unsubscribeSchedules: (() => void) | null = null;
  private readonly registrations = new Map<string, RegistrationRecord>();
  private readonly activeDeliveries = new Set<string>();
  private readonly deliverLocks = new Set<string>();
  private rebuildChain: Promise<void> = Promise.resolve();

  constructor(readonly dependencies: ReminderApplicationDependencies) {}

  async start(): Promise<void> {
    if (this.started) return;

    await this.dependencies.recovery.registerForRestart();
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

    await this.enqueueRebuild();

    this.unsubscribeSchedules = this.dependencies.schedules.subscribe(() => {
      void this.enqueueRebuild();
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started && this.timeListenerId == null) return;

    this.unsubscribePresenter?.();
    this.unsubscribePresenter = null;
    this.unsubscribeSchedules?.();
    this.unsubscribeSchedules = null;

    if (this.timeListenerId != null) {
      await this.dependencies.time.stop(this.timeListenerId);
      this.timeListenerId = null;
    }

    for (const registration of this.registrations.values()) {
      if (registration.location_listener_id != null) {
        await this.dependencies.location.unwatch(registration.location_listener_id);
      }
      if (registration.alarm_id != null) {
        await this.dependencies.alarms.cancel(registration.alarm_id);
      }
    }
    this.registrations.clear();
    this.activeDeliveries.clear();
    this.deliverLocks.clear();
    this.started = false;
  }

  async register(schedule: LocalReminderSchedule): Promise<ReminderRegistration> {
    const merged = await this.withStoredRuntime(schedule);
    if (!this.isSchedulable(merged)) {
      return {
        schedule_id: merged.id,
        time_listener_id: null,
        location_listener_id: null,
        alarm_id: null,
      };
    }

    const existing = this.registrations.get(merged.id);
    if (existing?.location_listener_id != null) {
      await this.dependencies.location.unwatch(existing.location_listener_id);
    }
    if (existing?.alarm_id != null) {
      await this.dependencies.alarms.cancel(existing.alarm_id);
    }

    let locationListenerId: string | null = null;
    let alarmId: string | null = null;

    if (merged.schedule_type === 'location') {
      const handle = await this.watchLocationSchedule(merged);
      locationListenerId = handle?.listener_id ?? null;
    }

    if (merged.schedule_type === 'time') {
      const receipt = await this.scheduleAlarmFor(merged);
      alarmId = receipt?.scheduled ? receipt.alarm_id : null;
    }

    const registration: RegistrationRecord = {
      schedule_id: merged.id,
      time_listener_id: this.timeListenerId,
      location_listener_id: locationListenerId,
      alarm_id: alarmId,
      schedule: merged,
    };
    this.registrations.set(merged.id, registration);
    return {
      schedule_id: registration.schedule_id,
      time_listener_id: registration.time_listener_id,
      location_listener_id: registration.location_listener_id,
      alarm_id: registration.alarm_id,
    };
  }

  async rebuild(): Promise<readonly ReminderRegistration[]> {
    return this.enqueueRebuild();
  }

  async handleTime(tick: { observed_at: string }): Promise<void> {
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    for (const raw of schedules) {
      const schedule = await this.withStoredRuntime(raw);
      if (!(await this.canDeliver(schedule, tick.observed_at))) continue;

      if (isSnoozeExpired(schedule, tick.observed_at)) {
        await this.deliver(this.buildTrigger(schedule, 'snooze_expired', tick.observed_at));
        continue;
      }

      if (isTimeWindowReached(schedule, tick.observed_at)) {
        const reason = toTimeReason(schedule);
        await this.deliver(this.buildTrigger(schedule, reason, tick.observed_at));
      }
    }
  }

  async handleLocation(sample: LocationSample): Promise<void> {
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    for (const raw of schedules) {
      const schedule = await this.withStoredRuntime(raw);
      if (schedule.schedule_type !== 'location') continue;
      if (!(await this.canDeliver(schedule, sample.observed_at))) continue;

      const mode = resolveWatchMode(schedule);
      const transition = evaluateGeofence(schedule, sample, mode);
      if (transition === 'armed') {
        await this.patchRuntime(schedule.id, {
          ...schedule.runtime,
          geofence_armed: true,
        });
        continue;
      }
      if (transition === 'triggered') {
        // 先消耗边沿（disarm），再送达；失败也不恢复 armed，避免圈内连响。
        await this.patchRuntime(schedule.id, {
          ...schedule.runtime,
          geofence_armed: false,
        });
        const reason = toLocationReason(schedule);
        await this.deliver(this.buildTrigger(schedule, reason, sample.observed_at));
      }
    }
  }

  async deliver(trigger: ReminderTrigger): Promise<ReminderDeliveryReceipt> {
    if (this.deliverLocks.has(trigger.schedule_id)) {
      return {
        delivery_id: `inflight-${trigger.schedule_id}`,
        schedule_id: trigger.schedule_id,
        delivered_at: trigger.triggered_at,
        channels: [],
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
          channels: [],
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
    await this.teardownDelivery(scheduleId);

    const disposition: ReminderDisposition = {
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

    const registration = this.registrations.get(scheduleId);
    if (registration?.alarm_id != null) {
      await this.dependencies.alarms.cancel(registration.alarm_id);
      registration.alarm_id = null;
    }
    if (registration?.location_listener_id != null) {
      await this.dependencies.location.unwatch(registration.location_listener_id);
      registration.location_listener_id = null;
    }
    this.registrations.delete(scheduleId);

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

  async snooze(request: ReminderSnoozeRequest): Promise<ReminderApplicationResult> {
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

    const raw =
      (await this.dependencies.schedules.getReminderSchedule(request.schedule_id)) ??
      this.registrations.get(request.schedule_id)?.schedule;
    if (raw != null) {
      const schedule = await this.withStoredRuntime({
        ...raw,
        runtime: nextRuntime,
      });
      const previous = this.registrations.get(request.schedule_id);
      if (previous?.alarm_id != null) {
        await this.dependencies.alarms.cancel(previous.alarm_id);
      }
      const receipt = await this.dependencies.alarms.schedule({
        schedule_id: schedule.id,
        trigger_at: snoozedUntil,
        title: schedule.title,
        exact: true,
      });
      const registration = this.registrations.get(request.schedule_id);
      if (registration != null) {
        registration.alarm_id = receipt.scheduled ? receipt.alarm_id : null;
        registration.schedule = schedule;
      }
    }

    this.activeDeliveries.delete(request.schedule_id);
    return { accepted: true, schedule_id: request.schedule_id, disposition };
  }

  private enqueueRebuild(): Promise<readonly ReminderRegistration[]> {
    const run = this.rebuildChain.then(() => this.rebuildInternal());
    this.rebuildChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async rebuildInternal(): Promise<readonly ReminderRegistration[]> {
    const schedules = await this.dependencies.schedules.listReminderSchedules();
    const active: LocalReminderSchedule[] = [];
    for (const raw of schedules) {
      const merged = await this.withStoredRuntime(raw);
      if (this.isSchedulable(merged)) {
        active.push(merged);
      }
    }

    for (const registration of [...this.registrations.values()]) {
      if (registration.location_listener_id != null) {
        await this.dependencies.location.unwatch(registration.location_listener_id);
      }
      if (registration.alarm_id != null) {
        await this.dependencies.alarms.cancel(registration.alarm_id);
      }
    }
    this.registrations.clear();

    const locationHandles = await this.dependencies.location.rebuild(active, (event) => {
      void this.handleLocationMonitorEvent(event);
    });
    const locationBySchedule = new Map<string, LocationWatchHandle>(
      locationHandles.map((handle) => [handle.schedule_id, handle]),
    );

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

    const results: ReminderRegistration[] = [];
    for (const schedule of active) {
      const alarm = alarmBySchedule.get(schedule.id);
      const registration: RegistrationRecord = {
        schedule_id: schedule.id,
        time_listener_id: this.timeListenerId,
        location_listener_id: locationBySchedule.get(schedule.id)?.listener_id ?? null,
        alarm_id: alarm?.scheduled ? alarm.alarm_id : null,
        schedule,
      };
      this.registrations.set(schedule.id, registration);
      results.push({
        schedule_id: registration.schedule_id,
        time_listener_id: registration.time_listener_id,
        location_listener_id: registration.location_listener_id,
        alarm_id: registration.alarm_id,
      });
    }
    return results;
  }

  private async handlePresentationAction(
    scheduleId: string,
    action: 'confirm' | 'snooze',
  ): Promise<void> {
    if (action === 'confirm') {
      await this.confirm(scheduleId, new Date().toISOString());
      return;
    }
    await this.snooze({ schedule_id: scheduleId, snooze_until: null });
  }

  private async handleLocationMonitorEvent(event: LocationMonitorEvent): Promise<void> {
    await this.handleLocation(event.sample);
  }

  private isSchedulable(schedule: LocalReminderSchedule): boolean {
    if (schedule.status !== 'active') return false;
    if (schedule.runtime.reminder_disposition_state === 'confirmed') return false;
    return true;
  }

  private async canDeliver(schedule: LocalReminderSchedule, nowIso: string): Promise<boolean> {
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
    await this.dependencies.presenter.hide(scheduleId);
    await this.dependencies.delivery.dismiss(scheduleId);
    await this.dependencies.audio.stop(scheduleId);
    await this.dependencies.vibration.stop();
    await this.dependencies.popup.dismiss(`reminder-${scheduleId}`);
    await this.dependencies.systemNotification.cancel(`reminder-${scheduleId}`);
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
