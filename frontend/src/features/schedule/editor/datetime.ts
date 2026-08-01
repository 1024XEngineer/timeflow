import { formatTimeValue } from '@/shared/utils/date';

export type PickerMode = 'date' | 'time';

export function parseDateValue(value: string) {
  const parts = value
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const next = new Date();
  next.setHours(0, 0, 0, 0);
  if (parts.length === 3 && parts[0] >= 1 && parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1) {
    next.setFullYear(parts[0], parts[1] - 1, parts[2]);
  }
  return next;
}

export function parseTimeValue(value: string) {
  const parsed = value.match(/^(\d{1,2}):(\d{2})$/);
  const next = new Date();
  if (parsed) next.setHours(Number(parsed[1]), Number(parsed[2]), 0, 0);
  else next.setSeconds(0, 0);
  return next;
}

export function parsePickerValue(value: string, mode: PickerMode) {
  return mode === 'date' ? parseDateValue(value) : parseTimeValue(value);
}

export function formatDateValue(value: Date) {
  return `${value.getFullYear()} / ${String(value.getMonth() + 1).padStart(2, '0')} / ${String(value.getDate()).padStart(2, '0')}`;
}

export function dateAndTimeFromIso(value?: string | null) {
  if (!value) return { date: '', time: '' };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date: '', time: '' };
  return { date: formatDateValue(parsed), time: formatTimeValue(parsed) };
}

/** 新建日程默认选下一分钟（当前分钟已过去/不允许创建）。 */
export function defaultCreateDateAndTime(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return { date: formatDateValue(next), time: formatTimeValue(next) };
}

export function isoFromDateAndTime(dateValue: string, timeValue: string) {
  const timeParts = timeValue.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeParts) return null;

  const date = parseDateValue(dateValue);
  // parseDateValue 在非法输入时回退到「今天」；需确认输入本身合法。
  const parts = dateValue
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 3 || parts[0] < 1 || parts[1] < 1 || parts[1] > 12 || parts[2] < 1) {
    return null;
  }

  date.setHours(Number(timeParts[1]), Number(timeParts[2]), 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function optionalNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function currentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
