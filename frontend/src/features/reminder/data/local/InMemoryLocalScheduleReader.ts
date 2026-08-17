import type { LocalScheduleReader } from '../../application/interfaces';
import type { LocalReminderSchedule } from '../../domain';

/**
 * 进程内日程投影，供调用方写入后再由 LocalReminderApplication rebuild/start 接管。
 * 正式本地 DB 接入前作为默认 LocalScheduleReader。
 */
export class InMemoryLocalScheduleReader implements LocalScheduleReader {
  private readonly byId = new Map<string, LocalReminderSchedule>();
  private readonly listeners = new Set<(schedules: readonly LocalReminderSchedule[]) => void>();

  list(): readonly LocalReminderSchedule[] {
    return [...this.byId.values()];
  }

  async listReminderSchedules(): Promise<readonly LocalReminderSchedule[]> {
    return this.list();
  }

  async getReminderSchedule(scheduleId: string): Promise<LocalReminderSchedule | null> {
    return this.byId.get(scheduleId) ?? null;
  }

  subscribe(listener: (schedules: readonly LocalReminderSchedule[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  replaceAll(schedules: readonly LocalReminderSchedule[]): void {
    this.byId.clear();
    for (const schedule of schedules) {
      this.byId.set(schedule.id, schedule);
    }
    this.notify();
  }

  upsert(schedule: LocalReminderSchedule): void {
    this.byId.set(schedule.id, schedule);
    this.notify();
  }

  remove(scheduleId: string): void {
    if (!this.byId.delete(scheduleId)) return;
    this.notify();
  }

  clear(): void {
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.notify();
  }

  private notify(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
