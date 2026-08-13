import { describe, expect, it } from '@jest/globals';

import { InMemoryLocalScheduleReader } from '../../../../src/features/reminder/data/local/InMemoryLocalScheduleReader';
import type { LocalReminderSchedule } from '../../../../src/features/reminder/domain';

const SCHEDULE: LocalReminderSchedule = {
  id: 'schedule-time',
  account_id: 'account-a',
  title: '晨会',
  schedule_type: 'time',
  schedule_kind: 'once',
  is_all_day: false,
  start_time: '2026-08-13T09:00:00.000Z',
  end_time: null,
  timezone: 'Asia/Shanghai',
  recurrence_rule: null,
  location_name: '会议室',
  latitude: null,
  longitude: null,
  geofence_radius_meters: 100,
  reminder: {
    reminder_type: 'at_time',
    reminder_trigger_at: '2026-08-13T09:00:00.000Z',
    reminder_offset_minutes: null,
    reminder_strength: 'medium',
  },
  runtime: {
    reminder_disposition_state: null,
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: false,
    disposition_updated_at: null,
    sync_status: 'pending',
    recorded_location: null,
  },
  status: 'active',
  revision: 1,
  cloud_revision: 1,
  updated_at: '2026-08-13T08:00:00.000Z',
};

describe('InMemoryLocalScheduleReader', () => {
  it('upserts, lists, and notifies subscribers without replaying on subscribe', () => {
    const reader = new InMemoryLocalScheduleReader();
    const snapshots: number[] = [];
    const unsubscribe = reader.subscribe((schedules) => {
      snapshots.push(schedules.length);
    });

    reader.upsert(SCHEDULE);
    expect(reader.list()).toEqual([SCHEDULE]);
    expect(snapshots).toEqual([1]);

    reader.replaceAll([{ ...SCHEDULE, id: 'b', title: '午会' }]);
    expect(reader.list()).toHaveLength(1);
    expect(reader.list()[0]?.id).toBe('b');
    expect(snapshots).toEqual([1, 1]);

    reader.remove('b');
    expect(reader.list()).toEqual([]);
    expect(snapshots).toEqual([1, 1, 0]);
    unsubscribe();
  });

  it('returns null for a missing schedule id', async () => {
    const reader = new InMemoryLocalScheduleReader();
    await expect(reader.getReminderSchedule('missing')).resolves.toBeNull();
    reader.upsert(SCHEDULE);
    await expect(reader.getReminderSchedule('schedule-time')).resolves.toMatchObject({
      title: '晨会',
    });
  });
});
