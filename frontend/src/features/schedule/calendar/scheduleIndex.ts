import type { Schedule } from '@/contracts';
import { dateKey } from '@/shared/utils/date';
import { scheduleDate } from '../presentation/scheduleFormat';

export type ScheduleIndex = {
  byDateKey: Map<string, Schedule[]>;
  locationSchedules: Schedule[];
  timeSchedules: Schedule[];
  markedDateKeys: string[];
};

/** 一次遍历活跃日程，按日期/类型分桶，供月视图使用。 */
export function buildScheduleIndex(items: Schedule[]): ScheduleIndex {
  const byDateKey = new Map<string, Schedule[]>();
  const locationSchedules: Schedule[] = [];
  const timeSchedules: Schedule[] = [];
  const markedKeys = new Set<string>();

  for (const item of items) {
    if (item.status === 'deleted') continue;

    if (item.schedule_type === 'location') {
      locationSchedules.push(item);
    }
    if (item.schedule_type === 'time') {
      timeSchedules.push(item);
    }

    const date = scheduleDate(item);
    if (!date) continue;
    const key = dateKey(date);
    const bucket = byDateKey.get(key);
    if (bucket) bucket.push(item);
    else byDateKey.set(key, [item]);
    if (item.schedule_type === 'time') markedKeys.add(key);
  }

  return {
    byDateKey,
    locationSchedules,
    timeSchedules,
    markedDateKeys: [...markedKeys],
  };
}

export function schedulesOnDate(index: ScheduleIndex, date: Date): Schedule[] {
  return index.byDateKey.get(dateKey(date)) ?? [];
}
