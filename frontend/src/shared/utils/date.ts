export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

export function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function startOfWeek(date: Date) {
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}

export function addDays(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function formatDate(date: Date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAY_LABELS[date.getDay() === 0 ? 6 : date.getDay() - 1]}`;
}

export function formatFullDate(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAY_LABELS[date.getDay() === 0 ? 6 : date.getDay() - 1]}`;
}

export function formatMonthDay(date: Date) {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatTimeValue(value: Date) {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function formatWeekRange(start: Date) {
  const end = addDays(start, 6);
  return `${formatMonthDay(start)}—${formatMonthDay(end)}`;
}
