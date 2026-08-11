import type { SQLiteDatabase } from 'expo-sqlite';

export const CURRENT_DATABASE_VERSION = 1;

export const CREATE_SCHEDULE_STORAGE_SQL = `
CREATE TABLE IF NOT EXISTS local_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('time', 'location')),
  schedule_kind TEXT NOT NULL DEFAULT 'once' CHECK (schedule_kind IN ('once', 'recurring')),
  title TEXT NOT NULL,
  is_all_day INTEGER NOT NULL DEFAULT 0 CHECK (is_all_day IN (0, 1)),
  start_time TEXT NULL,
  end_time TEXT NULL,
  timezone TEXT NOT NULL,
  recurrence_rule TEXT NULL,
  location_name TEXT NULL,
  latitude REAL NULL CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude REAL NULL CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  reminder_type TEXT NULL CHECK (
    reminder_type IS NULL OR reminder_type IN (
      'at_time',
      'before_start',
      'arrive_location',
      'return_to_recorded_location'
    )
  ),
  reminder_trigger_at TEXT NULL,
  reminder_offset_minutes INTEGER NULL CHECK (
    reminder_offset_minutes IS NULL OR reminder_offset_minutes >= 0
  ),
  reminder_strength TEXT NULL CHECK (
    reminder_strength IS NULL OR reminder_strength IN ('low', 'medium', 'high')
  ),
  reminder_disposition_state TEXT NULL CHECK (
    reminder_disposition_state IS NULL
    OR reminder_disposition_state IN ('pending', 'confirmed', 'snoozed')
  ),
  next_trigger_at TEXT NULL,
  snoozed_until TEXT NULL,
  geofence_armed INTEGER NOT NULL DEFAULT 0 CHECK (geofence_armed IN (0, 1)),
  disposition_updated_at TEXT NULL,
  sync_status TEXT NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('pending', 'synced')),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  cloud_revision INTEGER NOT NULL CHECK (cloud_revision > 0),
  updated_at TEXT NOT NULL,
  CHECK (
    (schedule_type = 'time' AND start_time IS NOT NULL)
    OR (
      schedule_type = 'location'
      AND start_time IS NULL
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND is_all_day = 0
    )
  ),
  CHECK (
    (schedule_kind = 'once' AND recurrence_rule IS NULL)
    OR (
      schedule_kind = 'recurring'
      AND schedule_type = 'time'
      AND recurrence_rule IS NOT NULL
    )
  ),
  CHECK (
    is_all_day = 0
    OR (schedule_type = 'time' AND start_time IS NOT NULL AND end_time IS NOT NULL)
  ),
  CHECK (
    (reminder_type IS NULL
      AND reminder_trigger_at IS NULL
      AND reminder_offset_minutes IS NULL
      AND reminder_strength IS NULL)
    OR (reminder_type IS NOT NULL AND reminder_strength IS NOT NULL)
  ),
  CHECK (
    reminder_type IS NULL
    OR (reminder_type = 'at_time'
      AND reminder_trigger_at IS NOT NULL
      AND reminder_offset_minutes IS NULL)
    OR (reminder_type = 'before_start'
      AND reminder_trigger_at IS NULL
      AND reminder_offset_minutes IS NOT NULL)
    OR (reminder_type IN ('arrive_location', 'return_to_recorded_location')
      AND reminder_trigger_at IS NULL
      AND reminder_offset_minutes IS NULL
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_local_schedules_account_status_start_time
  ON local_schedules (account_id, status, start_time);
CREATE INDEX IF NOT EXISTS ix_local_schedules_account_cloud_revision
  ON local_schedules (account_id, cloud_revision);

CREATE TABLE IF NOT EXISTS local_schedule_occurrence_overrides (
  id TEXT PRIMARY KEY NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES local_schedules(id) ON DELETE CASCADE,
  occurrence_start TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('cancel', 'replace')),
  replacement_schedule_id TEXT NULL REFERENCES local_schedules(id) ON DELETE RESTRICT,
  UNIQUE (schedule_id, occurrence_start),
  CHECK (
    (action = 'cancel' AND replacement_schedule_id IS NULL)
    OR (action = 'replace' AND replacement_schedule_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ix_local_schedule_overrides_replacement_schedule_id
  ON local_schedule_occurrence_overrides (replacement_schedule_id);
`;

export async function migrateScheduleDatabase(database: SQLiteDatabase): Promise<void> {
  await database.execAsync('PRAGMA foreign_keys = ON');
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion > CURRENT_DATABASE_VERSION) {
    throw new Error(
      `Unsupported Timeflow database version ${currentVersion}; expected at most ${CURRENT_DATABASE_VERSION}`,
    );
  }
  if (currentVersion === CURRENT_DATABASE_VERSION) {
    return;
  }

  await database.withExclusiveTransactionAsync(async (transaction) => {
    if (currentVersion < 1) {
      await transaction.execAsync(CREATE_SCHEDULE_STORAGE_SQL);
      await transaction.execAsync('PRAGMA user_version = 1');
    }
  });
}
