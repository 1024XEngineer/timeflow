import type { LocalScheduleRow } from '../../../schedule/data';
import type { LocalReminderSchedule, ReminderConfiguration } from '../../domain';

export const DEFAULT_GEOFENCE_RADIUS_METERS = 100;

/** 把 SQLite `local_schedules` 行投影成提醒运行时消费的日程。 */
export function toLocalReminderSchedule(row: LocalScheduleRow): LocalReminderSchedule {
  return {
    id: row.id,
    account_id: row.account_id,
    title: row.title,
    schedule_type: row.schedule_type,
    schedule_kind: row.schedule_kind,
    is_all_day: row.is_all_day === 1,
    start_time: row.start_time,
    end_time: row.end_time,
    timezone: row.timezone,
    recurrence_rule: row.recurrence_rule,
    location_name: row.location_name,
    latitude: row.latitude,
    longitude: row.longitude,
    geofence_radius_meters: DEFAULT_GEOFENCE_RADIUS_METERS,
    reminder: toReminderConfiguration(row),
    runtime: {
      reminder_disposition_state: row.reminder_disposition_state,
      next_trigger_at: row.next_trigger_at,
      snoozed_until: row.snoozed_until,
      geofence_armed: row.geofence_armed === 1,
      disposition_updated_at: row.disposition_updated_at,
      sync_status: row.sync_status,
      recorded_location: null,
    },
    status: row.status,
    revision: row.cloud_revision,
    cloud_revision: row.cloud_revision,
    updated_at: row.updated_at,
  };
}

function toReminderConfiguration(row: LocalScheduleRow): ReminderConfiguration | null {
  if (row.reminder_type == null || row.reminder_strength == null) return null;
  return {
    reminder_type: row.reminder_type,
    reminder_trigger_at: row.reminder_trigger_at,
    reminder_offset_minutes: row.reminder_offset_minutes,
    reminder_strength: row.reminder_strength,
  };
}
