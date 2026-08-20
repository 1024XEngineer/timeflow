import { describe, expect, it } from '@jest/globals';

import { parseScheduleSnapshotResponse } from '../../../src/contracts/sync';

function validSchedule() {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'recurring',
    category: 'work',
    title: 'Planning',
    is_all_day: false,
    start_time: '2026-08-18T01:00:00Z',
    end_time: '2026-08-18T02:00:00Z',
    timezone: 'Asia/Shanghai',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
    location_name: null,
    latitude: null,
    longitude: null,
    reminder_type: 'before_start',
    reminder_trigger_at: null,
    reminder_offset_minutes: 15,
    reminder_strength: 'medium',
    reminder_disposition_state: null,
    status: 'active',
    revision: 1,
    created_at: '2026-08-17T01:00:00Z',
    updated_at: '2026-08-17T02:00:00Z',
    deleted_at: null,
  };
}

function validOverride() {
  return {
    id: 'override-a',
    schedule_id: 'schedule-a',
    occurrence_start: '2026-08-25T01:00:00Z',
    action: 'cancel',
    replacement_schedule_id: null,
    created_at: '2026-08-17T01:00:00Z',
    updated_at: '2026-08-17T02:00:00Z',
  };
}

describe('parseScheduleSnapshotResponse', () => {
  it('accepts the complete backend response', () => {
    const response = {
      schedules: [validSchedule()],
      occurrence_overrides: [validOverride()],
    };

    expect(parseScheduleSnapshotResponse(response)).toEqual(response);
  });

  it('accepts an empty cloud account snapshot', () => {
    expect(parseScheduleSnapshotResponse({ schedules: [], occurrence_overrides: [] })).toEqual({
      schedules: [],
      occurrence_overrides: [],
    });
  });

  it('accepts finite coordinates', () => {
    const response = {
      schedules: [{ ...validSchedule(), latitude: 31.2304, longitude: 121.4737 }],
      occurrence_overrides: [],
    };

    expect(parseScheduleSnapshotResponse(response)).toEqual(response);
  });

  it.each([
    ['schedules', { schedules: {}, occurrence_overrides: [] }],
    ['occurrence overrides', { schedules: [], occurrence_overrides: {} }],
  ])('rejects non-array %s collection', (_name, response) => {
    expect(parseScheduleSnapshotResponse(response)).toBeUndefined();
  });

  it.each([
    ['non-object', []],
    ['missing top-level field', { schedules: [] }],
    ['unknown top-level field', { schedules: [], occurrence_overrides: [], extra: true }],
    [
      'invalid revision',
      { schedules: [{ ...validSchedule(), revision: 1.5 }], occurrence_overrides: [] },
    ],
    [
      'unknown enum',
      { schedules: [{ ...validSchedule(), status: 'archived' }], occurrence_overrides: [] },
    ],
    [
      'unknown category',
      { schedules: [{ ...validSchedule(), category: 'unsupported' }], occurrence_overrides: [] },
    ],
    [
      'invalid aware timestamp',
      { schedules: [{ ...validSchedule(), updated_at: '2026-08-17' }], occurrence_overrides: [] },
    ],
    [
      'invalid nullable value',
      { schedules: [{ ...validSchedule(), end_time: 42 }], occurrence_overrides: [] },
    ],
    [
      'invalid override',
      {
        schedules: [validSchedule()],
        occurrence_overrides: [{ ...validOverride(), action: 'move' }],
      },
    ],
  ])('rejects %s', (_name, response) => {
    expect(parseScheduleSnapshotResponse(response)).toBeUndefined();
  });
});
