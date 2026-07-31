import type { Schedule, ScheduleUpsertPayload as ScheduleDraft } from '@/contracts';
import { nextRequestId } from '@/shared/utils/requestId';

import type { AlarmPort } from './AlarmPort';
import { scheduleFromUpsertPayload, toUpsertCommand } from '../data/adapters';
import type { ScheduleCache } from '../data/ScheduleCache';
import type { ScheduleRepositoryPort } from '../data/ScheduleRepositoryPort';
import { markDeleted, nextStatusAfterToggle, withStatus } from '../domain/scheduleStatus';
import type { ScheduleConflictNotifier } from './ScheduleNotificationPort';

export type ScheduleServiceDeps = {
  repository: ScheduleRepositoryPort & { dispose?: () => void };
  cache: ScheduleCache;
  getUserId: () => string;
  alarmAdapter: AlarmPort;
  /** UI feedback is supplied by the app composition root, never by this use case. */
  notifyConflicts?: ScheduleConflictNotifier;
};

export class ScheduleAlarmSyncError extends Error {
  readonly alarmCause: unknown;

  constructor(message: string, cause: unknown) {
    const detail = cause instanceof Error ? `：${cause.message}` : '';
    super(`${message}${detail}`);
    this.name = 'ScheduleAlarmSyncError';
    this.alarmCause = cause;
  }
}

export class ScheduleService {
  private readonly alarm: AlarmPort;
  private pushUnsubscribe: (() => void) | null = null;
  private loadGeneration = 0;

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.alarm = deps.alarmAdapter;
  }

  async bootstrap(): Promise<void> {
    const generation = ++this.loadGeneration;
    const schedules = await this.deps.repository.list({
      status: null,
      include_deleted: false,
    });
    if (generation !== this.loadGeneration) return;
    this.deps.cache.replaceAll(schedules);
    if (!this.pushUnsubscribe) {
      this.pushUnsubscribe = this.deps.repository.subscribe((event) => {
        this.deps.cache.applyPush(event);
      });
    }
  }

  /** 重连后强制重新拉取列表。 */
  async resync(): Promise<void> {
    await this.bootstrap();
  }

  dispose(): void {
    this.loadGeneration += 1;
    this.pushUnsubscribe?.();
    this.pushUnsubscribe = null;
    this.deps.repository.dispose?.();
  }

  getItems(): Schedule[] {
    return this.deps.cache.getSnapshot();
  }

  subscribe(listener: (items: Schedule[]) => void): () => void {
    return this.deps.cache.subscribe(listener);
  }

  async saveDraft(draft: ScheduleDraft): Promise<Schedule> {
    const userId = this.deps.getUserId();
    const requestId = nextRequestId('req_schedule');
    // A missing ID means create. The backend owns ID generation; sending a
    // client-generated ID makes the MVP backend treat the command as an edit.
    const command = toUpsertCommand(draft, requestId);
    const existing = draft.schedule_id
      ? (this.deps.cache.getSnapshot().find((item) => item.id === draft.schedule_id) ?? null)
      : null;

    const response = await this.deps.repository.upsert(command);
    if (!response.ok) {
      throw new Error(response.error.message);
    }

    if (response.payload.conflicts.length > 0) {
      try {
        this.deps.notifyConflicts?.(response.payload.conflicts);
      } catch {
        // User feedback must not turn a successful server write into a failed
        // mutation when a host notifier is unavailable.
      }
    }

    const scheduleId = response.payload.schedule_id;

    const confirmedEntity = scheduleFromUpsertPayload({
      draft: { ...draft, schedule_id: scheduleId },
      scheduleId,
      userId,
      status: response.payload.status,
      geofenceArmed: response.payload.geofence_armed,
      existing,
      systemScheduleRefId: existing?.system_schedule_ref_id ?? null,
    });
    this.deps.cache.upsert(confirmedEntity);

    const offsetMinutes = draft.time_remind_offset_minutes ?? 0;
    let syncedSystemScheduleRefId: string | null;
    try {
      syncedSystemScheduleRefId = await this.alarm.syncForSchedule({
        scheduleType: draft.schedule_type,
        title: draft.title,
        startTime: draft.start_time ?? null,
        offsetMinutes,
        previousAlarmId: existing?.system_schedule_ref_id ?? null,
        shouldArm: response.payload.status === 'scheduled',
      });
    } catch (error) {
      throw new ScheduleAlarmSyncError('日程已保存到服务端，但系统提醒同步失败', error);
    }

    const entity = { ...confirmedEntity, system_schedule_ref_id: syncedSystemScheduleRefId };
    this.deps.cache.upsert(entity);
    return entity;
  }

  async toggleDone(schedule: Schedule): Promise<void> {
    const nextStatus = nextStatusAfterToggle(schedule.status);
    if (!nextStatus || nextStatus === 'deleted') return;

    const response = await this.deps.repository.updateStatus(schedule.id, nextStatus);
    if (!response.ok) {
      throw new Error(response.error.message);
    }

    const confirmedEntity = withStatus(
      schedule,
      response.payload.status,
      schedule.system_schedule_ref_id,
    );
    this.deps.cache.upsert(confirmedEntity);

    let systemScheduleRefId = schedule.system_schedule_ref_id;
    try {
      if (nextStatus === 'done') {
        systemScheduleRefId = await this.alarm.cancel(systemScheduleRefId);
      } else {
        systemScheduleRefId = await this.alarm.syncForSchedule({
          scheduleType: schedule.schedule_type,
          title: schedule.title,
          startTime: schedule.start_time,
          offsetMinutes: schedule.time_remind_offset_minutes,
          previousAlarmId: schedule.system_schedule_ref_id,
          shouldArm: true,
        });
      }
    } catch (error) {
      throw new ScheduleAlarmSyncError('日程状态已在服务端更新，但系统提醒同步失败', error);
    }

    this.deps.cache.upsert(
      withStatus(confirmedEntity, response.payload.status, systemScheduleRefId),
    );
  }

  async deleteSchedule(schedule: Schedule): Promise<void> {
    if (schedule.status === 'deleted') return;
    const response = await this.deps.repository.notifyDeleted(schedule.id);
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    const confirmedEntity = markDeleted(schedule, schedule.system_schedule_ref_id);
    this.deps.cache.upsert(confirmedEntity);
    let systemScheduleRefId: string | null;
    try {
      systemScheduleRefId = await this.alarm.cancel(schedule.system_schedule_ref_id);
    } catch (error) {
      throw new ScheduleAlarmSyncError('日程已在服务端删除，但系统提醒取消失败', error);
    }
    this.deps.cache.upsert(markDeleted(confirmedEntity, systemScheduleRefId));
  }
}
