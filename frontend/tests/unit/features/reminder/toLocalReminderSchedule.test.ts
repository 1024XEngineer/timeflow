import { describe, expect, it } from '@jest/globals';

import type { LocalScheduleRow } from '../../../../src/features/schedule/data';
import {
  DEFAULT_GEOFENCE_RADIUS_METERS,
  toLocalReminderSchedule,
} from '../../../../src/features/reminder/data/local/toLocalReminderSchedule';

function row(overrides: Partial<LocalScheduleRow> = {}): LocalScheduleRow {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'once',
    title: '晨会',
    is_all_day: 0,
    start_time: '2026-08-13T09:00:00.000Z',
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: '会议室',
    latitude: null,
    longitude: null,
    reminder_type: 'at_time',
    reminder_trigger_at: '2026-08-13T09:00:00.000Z',
    reminder_offset_minutes: null,
    reminder_strength: 'medium',
    reminder_disposition_state: null,
    status: 'active',
    cloud_revision: 3,
    updated_at: '2026-08-13T08:00:00.000Z',
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: 0,
    disposition_updated_at: null,
    sync_status: 'pending',
    ...overrides,
  };
}

describe('toLocalReminderSchedule', () => {
  it('projects a SQLite row onto the reminder runtime schedule', () => {
    expect(toLocalReminderSchedule(row())).toEqual({
      id: 'schedule-a',
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
      geofence_radius_meters: DEFAULT_GEOFENCE_RADIUS_METERS,
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
      revision: 3,
      cloud_revision: 3,
      updated_at: '2026-08-13T08:00:00.000Z',
    });
  });

  it('drops reminder config when type or strength is missing', () => {
    expect(toLocalReminderSchedule(row({ reminder_type: null })).reminder).toBeNull();
    expect(toLocalReminderSchedule(row({ reminder_strength: null })).reminder).toBeNull();
  });

  it('maps all-day and geofence flags from SQLite integers', () => {
    const mapped = toLocalReminderSchedule(
      row({ is_all_day: 1, geofence_armed: 1, latitude: 31.23, longitude: 121.47 }),
    );
    expect(mapped.is_all_day).toBe(true);
    expect(mapped.runtime.geofence_armed).toBe(true);
    expect(mapped.latitude).toBe(31.23);
  });
});
