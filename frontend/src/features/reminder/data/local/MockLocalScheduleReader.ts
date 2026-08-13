import type { LocalScheduleReader } from '../../application/interfaces';
import type { LocalReminderSchedule } from '../../domain';

import { MOCK_REMINDER_SCHEDULES } from './mockReminderSchedules';

/** 代替本地数据库端口的固定只读适配器。 */
export class MockLocalScheduleReader implements LocalScheduleReader {
  readonly schedules = MOCK_REMINDER_SCHEDULES;
  private readonly listeners = new Set<(schedules: readonly LocalReminderSchedule[]) => void>();

  async listReminderSchedules(): Promise<readonly LocalReminderSchedule[]> {
    return this.schedules;
  }

  async getReminderSchedule(scheduleId: string): Promise<LocalReminderSchedule | null> {
    return this.schedules.find((schedule) => schedule.id === scheduleId) ?? null;
  }

  subscribe(listener: (schedules: readonly LocalReminderSchedule[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 测试或本地写入后通知订阅方；subscribe 本身不重放，避免与 start/rebuild 重入。 */
  notify(): void {
    for (const listener of this.listeners) {
      listener(this.schedules);
    }
  }
}
