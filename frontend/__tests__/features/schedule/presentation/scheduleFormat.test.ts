import { describe, expect, it } from '@jest/globals';

import type { Schedule } from '@/contracts';

import {
  scheduleColor,
  scheduleDate,
  scheduleDuration,
  scheduleRange,
  scheduleSourceLabel,
  scheduleStatusLabel,
  scheduleTime,
  timeToMinutes,
} from '@/features/schedule/presentation/scheduleFormat';

// Built from local-time components on purpose: the formatters read getHours()
// and friends, so a fixed offset string would make these tests timezone-bound.
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule_test',
    user_id: 'default_user',
    source_mode: 'manual',
    schedule_type: 'time',
    status: 'scheduled',
    title: '测试日程',
    notes: null,
    start_time: new Date(2026, 6, 29, 9, 5).toISOString(),
    end_time: null,
    timezone: 'Asia/Shanghai',
    location_name: null,
    location_address: null,
    latitude: null,
    longitude: null,
    geofence_radius_meters: 100,
    geofence_armed: false,
    time_remind_offset_minutes: 15,
    time_triggered_at: null,
    geo_triggered_at: null,
    system_schedule_ref_id: null,
    system_alarm_ref_id: null,
    created_at: new Date(2026, 6, 20, 10, 0).toISOString(),
    updated_at: new Date(2026, 6, 20, 10, 0).toISOString(),
    ...overrides,
  };
}

describe('scheduleDate', () => {
  it('returns null when there is no start time', () => {
    expect(scheduleDate(makeSchedule({ start_time: null }))).toBeNull();
  });

  it('returns null for an unparseable start time', () => {
    expect(scheduleDate(makeSchedule({ start_time: 'not-a-date' }))).toBeNull();
  });
});

describe('scheduleTime', () => {
  it('pads hours and minutes to two digits', () => {
    expect(scheduleTime(makeSchedule())).toBe('09:05');
  });

  it('falls back to 地点 for schedules without a start time', () => {
    expect(scheduleTime(makeSchedule({ start_time: null }))).toBe('地点');
  });
});

describe('scheduleRange', () => {
  it('joins start and end times', () => {
    const item = makeSchedule({ end_time: new Date(2026, 6, 29, 10, 40).toISOString() });
    expect(scheduleRange(item)).toBe('09:05–10:40');
  });

  it('returns only the start when there is no end time', () => {
    expect(scheduleRange(makeSchedule())).toBe('09:05');
  });

  it('ignores an unparseable end time', () => {
    expect(scheduleRange(makeSchedule({ end_time: 'not-a-date' }))).toBe('09:05');
  });

  it('prefers the location name for location schedules', () => {
    const item = makeSchedule({ start_time: null, location_name: '办公室' });
    expect(scheduleRange(item)).toBe('办公室');
  });

  it('falls back to a generic label with neither time nor place', () => {
    expect(scheduleRange(makeSchedule({ start_time: null }))).toBe('地点提醒');
  });
});

describe('scheduleDuration', () => {
  it('reports the gap in minutes', () => {
    const item = makeSchedule({ end_time: new Date(2026, 6, 29, 9, 40).toISOString() });
    expect(scheduleDuration(item)).toBe('35 分钟');
  });

  it('reports 未设置时长 when the end time is missing', () => {
    expect(scheduleDuration(makeSchedule())).toBe('未设置时长');
  });

  it('reports 未设置时长 when the end is not after the start', () => {
    const item = makeSchedule({ end_time: new Date(2026, 6, 29, 9, 5).toISOString() });
    expect(scheduleDuration(item)).toBe('未设置时长');
  });
});

describe('scheduleColor', () => {
  it('uses the done colour whatever the type is', () => {
    expect(scheduleColor(makeSchedule({ status: 'done', schedule_type: 'location' }))).toBe(
      '#A8C7B5',
    );
  });

  it('distinguishes location, voice and manual schedules', () => {
    expect(scheduleColor(makeSchedule({ schedule_type: 'location' }))).toBe('#E79472');
    expect(scheduleColor(makeSchedule({ source_mode: 'voice' }))).toBe('#AEC46B');
    expect(scheduleColor(makeSchedule())).toBe('#7DA6B8');
  });
});

describe('label helpers', () => {
  it('names the creation source', () => {
    expect(scheduleSourceLabel(makeSchedule({ source_mode: 'voice' }))).toBe('语音创建');
    expect(scheduleSourceLabel(makeSchedule())).toBe('手动创建');
  });

  it('names all three statuses', () => {
    expect(scheduleStatusLabel(makeSchedule({ status: 'done' }))).toBe('已完成');
    expect(scheduleStatusLabel(makeSchedule({ status: 'deleted' }))).toBe('已删除');
    expect(scheduleStatusLabel(makeSchedule())).toBe('待完成');
  });
});

describe('timeToMinutes', () => {
  it('counts minutes since midnight', () => {
    expect(timeToMinutes('08:30')).toBe(510);
    expect(timeToMinutes('00:00')).toBe(0);
  });
});
