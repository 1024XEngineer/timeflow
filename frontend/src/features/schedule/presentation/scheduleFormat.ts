import type { Schedule } from '@/contracts';
import { formatTimeValue } from '@/shared/utils/date';

export function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function scheduleDate(item: Schedule) {
  if (!item.start_time) return null;
  const value = new Date(item.start_time);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function scheduleTime(item: Schedule) {
  const date = scheduleDate(item);
  return date ? formatTimeValue(date) : '地点';
}

export function scheduleRange(item: Schedule) {
  const start = scheduleDate(item);
  if (!start) return item.location_name ?? item.location_address ?? '地点提醒';
  const startLabel = scheduleTime(item);
  if (!item.end_time) return startLabel;
  const end = new Date(item.end_time);
  if (Number.isNaN(end.getTime())) return startLabel;
  return `${startLabel}–${formatTimeValue(end)}`;
}

export function scheduleDuration(item: Schedule) {
  const start = scheduleDate(item);
  const end = item.end_time ? new Date(item.end_time) : null;
  if (!start || !end || Number.isNaN(end.getTime())) return '未设置时长';
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  return minutes > 0 ? `${minutes} 分钟` : '未设置时长';
}

export function scheduleColor(item: Schedule) {
  if (item.status === 'done') return '#A8C7B5';
  if (item.schedule_type === 'location') return '#E79472';
  return item.source_mode === 'voice' ? '#AEC46B' : '#7DA6B8';
}

export function scheduleSourceLabel(item: Schedule) {
  return item.source_mode === 'voice' ? '语音创建' : '手动创建';
}

/** 只映射契约里的三种 status，不做「已过期」等过程态。 */
export function scheduleStatusLabel(item: Schedule) {
  if (item.status === 'done') return '已完成';
  if (item.status === 'deleted') return '已删除';
  return '待完成';
}
