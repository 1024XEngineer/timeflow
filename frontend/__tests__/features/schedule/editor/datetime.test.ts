import { describe, expect, it } from '@jest/globals';

import {
  currentTimezone,
  dateAndTimeFromIso,
  defaultCreateDateAndTime,
  formatDateValue,
  isoFromDateAndTime,
  optionalNumber,
  parseDateValue,
  parsePickerValue,
  parseTimeValue,
} from '@/features/schedule/editor/datetime';
import { formatTimeValue } from '@/shared/utils/date';

describe('parseDateValue', () => {
  it('round-trips the format the field renders', () => {
    expect(formatDateValue(parseDateValue('2026 / 07 / 29'))).toBe('2026 / 07 / 29');
  });

  it('accepts any non-digit separator', () => {
    expect(formatDateValue(parseDateValue('2026-7-29'))).toBe('2026 / 07 / 29');
  });

  it('falls back to today when the input is incomplete', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    expect(parseDateValue('2026 / 07').getTime()).toBe(today.getTime());
  });
});

describe('parseTimeValue', () => {
  it('reads hours and minutes', () => {
    expect(formatTimeValue(parseTimeValue('09:05'))).toBe('09:05');
  });

  it('accepts a single-digit hour', () => {
    expect(formatTimeValue(parseTimeValue('9:05'))).toBe('09:05');
  });
});

describe('isoFromDateAndTime', () => {
  it('combines the two fields into one instant', () => {
    expect(isoFromDateAndTime('2026 / 07 / 29', '09:05')).toBe(
      new Date(2026, 6, 29, 9, 5).toISOString(),
    );
  });

  it('returns null when the time does not parse', () => {
    expect(isoFromDateAndTime('2026 / 07 / 29', '9am')).toBeNull();
  });

  it('returns null when the date is incomplete', () => {
    expect(isoFromDateAndTime('2026 / 07', '09:05')).toBeNull();
  });
});

describe('defaultCreateDateAndTime', () => {
  it('defaults to the next whole minute', () => {
    expect(defaultCreateDateAndTime(new Date(2026, 6, 30, 13, 58, 40, 123))).toEqual({
      date: '2026 / 07 / 30',
      time: '13:59',
    });
  });

  it('rolls to the next day near midnight', () => {
    expect(defaultCreateDateAndTime(new Date(2026, 6, 30, 23, 59, 10))).toEqual({
      date: '2026 / 07 / 31',
      time: '00:00',
    });
  });
});

describe('dateAndTimeFromIso', () => {
  it('returns empty strings for a missing value', () => {
    expect(dateAndTimeFromIso(null)).toEqual({ date: '', time: '' });
  });

  it('returns empty strings for an unparseable value', () => {
    expect(dateAndTimeFromIso('not-a-date')).toEqual({ date: '', time: '' });
  });

  it('splits an ISO string back into the two fields', () => {
    expect(dateAndTimeFromIso(new Date(2026, 6, 29, 9, 5).toISOString())).toEqual({
      date: '2026 / 07 / 29',
      time: '09:05',
    });
  });
});

describe('optionalNumber', () => {
  it('treats blank input as absent rather than zero', () => {
    expect(optionalNumber('')).toBeNull();
    expect(optionalNumber('   ')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(optionalNumber('abc')).toBeNull();
  });

  it('keeps negative and decimal values', () => {
    expect(optionalNumber('-31.2451')).toBe(-31.2451);
    expect(optionalNumber('0')).toBe(0);
  });
});

describe('parsePickerValue', () => {
  it('delegates to date or time parsers by mode', () => {
    expect(formatDateValue(parsePickerValue('2026 / 07 / 29', 'date'))).toBe('2026 / 07 / 29');
    expect(formatTimeValue(parsePickerValue('09:05', 'time'))).toBe('09:05');
  });
});

describe('parseTimeValue fallback', () => {
  it('keeps the current clock when the string does not match', () => {
    const parsed = parseTimeValue('bad');
    expect(parsed.getSeconds()).toBe(0);
    expect(parsed.getMilliseconds()).toBe(0);
  });
});

describe('currentTimezone', () => {
  it('returns the runtime timezone when Intl is available', () => {
    expect(typeof currentTimezone()).toBe('string');
  });
});
