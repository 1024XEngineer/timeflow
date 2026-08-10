import type { LocalScheduleReader } from '../../application/interfaces';
import type { LocalReminderSchedule } from '../../domain';

import { MOCK_REMINDER_SCHEDULES } from './mockReminderSchedules';

/** 代替本地数据库端口的固定只读适配器。 */
export class MockLocalScheduleReader implements LocalScheduleReader {
  readonly schedules = MOCK_REMINDER_SCHEDULES;

  async listReminderSchedules(): Promise<readonly LocalReminderSchedule[]> {
    return this.schedules;
  }

  async getReminderSchedule(scheduleId: string): Promise<LocalReminderSchedule | null> {
    return this.schedules.find((schedule) => schedule.id === scheduleId) ?? null;
  }

  subscribe(listener: (schedules: readonly LocalReminderSchedule[]) => void): () => void {
    listener(this.schedules);
    return () => undefined;
  }
}
