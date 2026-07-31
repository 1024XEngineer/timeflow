import type { Schedule } from '@/contracts';

import { compareSchedules } from '../domain/scheduleOrdering';

import type { SchedulePushEvent } from './ScheduleRepositoryPort';

/** 本地列表真相：由 list/upsert/push 更新，供 UI 订阅。 */
export class ScheduleCache {
  private items: Schedule[] = [];
  private readonly listeners = new Set<(items: Schedule[]) => void>();

  getSnapshot(): Schedule[] {
    return this.items;
  }

  subscribe(listener: (items: Schedule[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.items);
    return () => this.listeners.delete(listener);
  }

  replaceAll(schedules: Schedule[]): void {
    this.items = [...schedules].sort(compareSchedules);
    this.emit();
  }

  upsert(schedule: Schedule): void {
    const index = this.items.findIndex((item) => item.id === schedule.id);
    if (index < 0) {
      this.items = [...this.items, schedule].sort(compareSchedules);
    } else {
      const next = [...this.items];
      next[index] = schedule;
      this.items = next.sort(compareSchedules);
    }
    this.emit();
  }

  applyPush(event: SchedulePushEvent): void {
    if (event.type === 'schedule.snapshot') {
      this.replaceAll(event.schedules);
      return;
    }
    this.upsert(event.schedule);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.items);
    }
  }
}
