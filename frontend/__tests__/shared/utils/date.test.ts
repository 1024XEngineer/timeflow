import { describe, expect, it } from '@jest/globals';

import {
  addDays,
  dateKey,
  formatDate,
  formatFullDate,
  formatMonthDay,
  formatWeekRange,
  startOfMonth,
  startOfWeek,
} from '@/shared/utils/date';

describe('dateKey', () => {
  it('pads single-digit months and days', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('leaves two-digit values alone', () => {
    expect(dateKey(new Date(2026, 11, 25))).toBe('2026-12-25');
  });
});

describe('startOfWeek', () => {
  it('treats Monday as the first day of the week', () => {
    expect(dateKey(startOfWeek(new Date(2026, 6, 29)))).toBe('2026-07-27');
  });

  it('maps Sunday back to the Monday that started it', () => {
    expect(dateKey(startOfWeek(new Date(2026, 7, 2)))).toBe('2026-07-27');
  });

  it('is a no-op when the date is already Monday', () => {
    expect(dateKey(startOfWeek(new Date(2026, 6, 27)))).toBe('2026-07-27');
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(dateKey(addDays(new Date(2026, 6, 30), 3))).toBe('2026-08-02');
  });

  it('accepts a negative amount', () => {
    expect(dateKey(addDays(new Date(2026, 7, 1), -1))).toBe('2026-07-31');
  });
});

describe('startOfMonth', () => {
  it('returns the first day of the month', () => {
    expect(dateKey(startOfMonth(new Date(2026, 6, 29)))).toBe('2026-07-01');
  });
});

describe('formatDate', () => {
  it('renders month, day and weekday', () => {
    expect(formatDate(new Date(2026, 6, 29))).toBe('7月29日 · 星期三');
  });

  it('labels Sunday as 星期日 rather than 星期一', () => {
    expect(formatDate(new Date(2026, 7, 2))).toBe('8月2日 · 星期日');
  });
});

describe('formatFullDate', () => {
  it('includes the year', () => {
    expect(formatFullDate(new Date(2026, 6, 29))).toBe('2026年7月29日 · 星期三');
  });
});

describe('formatMonthDay', () => {
  it('does not pad single-digit values', () => {
    expect(formatMonthDay(new Date(2026, 0, 5))).toBe('1月5日');
  });
});

describe('formatWeekRange', () => {
  it('spans seven days from the given start', () => {
    expect(formatWeekRange(new Date(2026, 6, 27))).toBe('7月27日—8月2日');
  });
});
