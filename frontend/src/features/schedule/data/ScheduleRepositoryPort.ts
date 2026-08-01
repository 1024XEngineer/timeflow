import type {
  Schedule,
  ScheduleDeletedAck,
  ScheduleListQueryPayload,
  ScheduleStatus,
  ScheduleStatusUpdateResponse,
  ScheduleUpsertCommand,
  ScheduleUpsertResponse,
} from '@/contracts';

export type SchedulePushEvent =
  | { type: 'schedule.updated'; schedule: Schedule }
  | { type: 'schedule.snapshot'; schedules: Schedule[] };

export interface ScheduleRepositoryPort {
  list(query: ScheduleListQueryPayload): Promise<Schedule[]>;
  upsert(command: ScheduleUpsertCommand): Promise<ScheduleUpsertResponse>;
  updateStatus(
    scheduleId: string,
    status: Extract<ScheduleStatus, 'scheduled' | 'done'>,
  ): Promise<ScheduleStatusUpdateResponse>;
  notifyDeleted(scheduleId: string): Promise<ScheduleDeletedAck>;
  subscribe(listener: (event: SchedulePushEvent) => void): () => void;
}
