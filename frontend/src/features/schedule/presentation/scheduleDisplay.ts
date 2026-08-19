import type { ScheduleOccurrenceView } from '../application';

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function formatAgendaSectionTitle(selectedDate: Date, today: Date = new Date()): string {
  if (dateKey(selectedDate) === dateKey(today)) {
    return '今日安排';
  }
  return `${selectedDate.getMonth() + 1}月${selectedDate.getDate()}日的安排`;
}

export function emptyAgendaMessage(selectedDate: Date, today: Date = new Date()): {
  title: string;
  detail: string | null;
} {
  if (dateKey(selectedDate) < dateKey(today)) {
    return { title: '这一天是属于你的', detail: null };
  }
  return {
    title: '这一天暂时没有日程',
    detail: '留一点时间给自己，或用语音助手添加安排。',
  };
}

export function dateKeyInTimezone(instant: string, timezone: string): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

export function formatTime(instant: string | null, timezone: string): string {
  if (instant === null) return '全天';
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatRange(item: ScheduleOccurrenceView): string {
  if (item.isAllDay) return '全天';
  const start = formatTime(item.occurrenceStart, item.timezone);
  const end = item.occurrenceEnd ? formatTime(item.occurrenceEnd, item.timezone) : null;
  return end ? `${start} - ${end}` : start;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}
