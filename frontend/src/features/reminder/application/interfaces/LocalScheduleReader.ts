import type { LocalReminderSchedule } from '../../domain';

/** 本地日程或本地数据库投影的只读边界。 */
export interface LocalScheduleReader {
  listReminderSchedules(): Promise<readonly LocalReminderSchedule[]>;
  getReminderSchedule(scheduleId: string): Promise<LocalReminderSchedule | null>;
  subscribe(listener: (schedules: readonly LocalReminderSchedule[]) => void): () => void;
}
