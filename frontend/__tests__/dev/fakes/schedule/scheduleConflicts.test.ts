import { describe, expect, it } from '@jest/globals';

import type { Schedule, ScheduleUpsertCommand } from '@/contracts';

import { upsertSchedule } from '@/dev/fakes/schedule/scheduleConflicts';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule_existing',
    user_id: 'default_user',
    source_mode: 'manual',
    schedule_type: 'time',
    status: 'scheduled',
    title: '已有日程',
    notes: null,
    start_time: new Date(2026, 6, 29, 9, 0).toISOString(),
    end_time: new Date(2026, 6, 29, 10, 0).toISOString(),
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

function makeCommand(startHour: number, endHour: number | null): ScheduleUpsertCommand {
  return {
    type: 'schedule.upsert.command',
    request_id: 'req_test',
    payload: {
      source_mode: 'manual',
      schedule_type: 'time',
      title: '新日程',
      start_time: new Date(2026, 6, 29, startHour, 0).toISOString(),
      end_time: endHour === null ? null : new Date(2026, 6, 29, endHour, 0).toISOString(),
    },
  };
}

describe('upsertSchedule conflict detection', () => {
  const existing = [makeSchedule()];

  it('flags a schedule that overlaps an existing one', () => {
    const result = upsertSchedule(makeCommand(9, 10), existing, 'schedule_new');
    expect(result.payload.conflicts.map((conflict) => conflict.schedule_id)).toEqual([
      'schedule_existing',
    ]);
  });

  it('flags a partial overlap', () => {
    const result = upsertSchedule(makeCommand(9, 11), existing, 'schedule_new');
    expect(result.payload.conflicts).toHaveLength(1);
  });

  it('treats touching boundaries as a conflict', () => {
    const result = upsertSchedule(makeCommand(10, 11), existing, 'schedule_new');
    expect(result.payload.conflicts).toHaveLength(1);
  });

  it('reports nothing for a non-overlapping slot', () => {
    const result = upsertSchedule(makeCommand(11, 12), existing, 'schedule_new');
    expect(result.payload.conflicts).toHaveLength(0);
  });

  it('does not conflict a schedule with itself while editing', () => {
    const result = upsertSchedule(makeCommand(9, 10), existing, 'schedule_existing');
    expect(result.payload.conflicts).toHaveLength(0);
  });

  it('ignores deleted schedules', () => {
    const deleted = [makeSchedule({ status: 'deleted' })];
    const result = upsertSchedule(makeCommand(9, 10), deleted, 'schedule_new');
    expect(result.payload.conflicts).toHaveLength(0);
  });

  it('reports nothing when the new schedule has no start time', () => {
    const command: ScheduleUpsertCommand = {
      type: 'schedule.upsert.command',
      request_id: 'req_test',
      payload: {
        source_mode: 'manual',
        schedule_type: 'location',
        title: '地点日程',
        start_time: null,
      },
    };
    const result = upsertSchedule(command, existing, 'schedule_new');
    expect(result.payload.conflicts).toHaveLength(0);
  });

  it('echoes the request id and schedule id back', () => {
    const result = upsertSchedule(makeCommand(14, 15), existing, 'schedule_new');
    expect(result.request_id).toBe('req_test');
    expect(result.payload.schedule_id).toBe('schedule_new');
  });

  it('ignores unparseable start times on the new command', () => {
    const command: ScheduleUpsertCommand = {
      type: 'schedule.upsert.command',
      request_id: 'req_test',
      payload: {
        source_mode: 'manual',
        schedule_type: 'time',
        title: '坏时间',
        start_time: 'not-a-date',
        end_time: null,
      },
    };
    expect(upsertSchedule(command, existing, 'schedule_new').payload.conflicts).toHaveLength(0);
  });

  it('ignores existing items whose times do not parse', () => {
    const broken = [makeSchedule({ id: 'broken', start_time: 'bad', end_time: 'also-bad' })];
    expect(
      upsertSchedule(makeCommand(9, 10), broken, 'schedule_new').payload.conflicts,
    ).toHaveLength(0);
  });

  it('inherits geofence_armed from the existing schedule when omitted', () => {
    const armed = [makeSchedule({ id: 'schedule_existing', geofence_armed: true })];
    const command = makeCommand(14, 15);
    delete (command.payload as { geofence_armed?: boolean }).geofence_armed;
    expect(upsertSchedule(command, armed, 'schedule_existing').payload.geofence_armed).toBe(true);
  });
});
