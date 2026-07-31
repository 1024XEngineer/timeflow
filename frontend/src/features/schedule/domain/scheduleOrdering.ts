import type { Schedule } from '@/contracts';

export function compareSchedules(first: Schedule, second: Schedule) {
  if (first.start_time && second.start_time) {
    return new Date(first.start_time).getTime() - new Date(second.start_time).getTime();
  }
  if (first.start_time) return -1;
  if (second.start_time) return 1;
  return new Date(second.created_at).getTime() - new Date(first.created_at).getTime();
}
