import { describe, expect, it } from '@jest/globals';

import { makeSchedule } from '@test/fixtures';

import { compareSchedules } from '@/features/schedule/domain/scheduleOrdering';

describe('compareSchedules', () => {
  it('orders by start_time when both have one', () => {
    const earlier = makeSchedule({
      id: 'a',
      start_time: new Date(2026, 6, 29, 8, 0).toISOString(),
    });
    const later = makeSchedule({
      id: 'b',
      start_time: new Date(2026, 6, 29, 10, 0).toISOString(),
    });
    expect(compareSchedules(earlier, later)).toBeLessThan(0);
    expect(compareSchedules(later, earlier)).toBeGreaterThan(0);
  });

  it('puts timed schedules before location-only ones', () => {
    const timed = makeSchedule({ id: 't', start_time: new Date(2026, 6, 29, 9, 0).toISOString() });
    const locationOnly = makeSchedule({ id: 'l', start_time: null });
    expect(compareSchedules(timed, locationOnly)).toBe(-1);
    expect(compareSchedules(locationOnly, timed)).toBe(1);
  });

  it('falls back to created_at when neither has start_time', () => {
    const older = makeSchedule({
      id: 'old',
      start_time: null,
      created_at: new Date(2026, 6, 1).toISOString(),
    });
    const newer = makeSchedule({
      id: 'new',
      start_time: null,
      created_at: new Date(2026, 6, 20).toISOString(),
    });
    expect(compareSchedules(older, newer)).toBeGreaterThan(0);
  });
});
