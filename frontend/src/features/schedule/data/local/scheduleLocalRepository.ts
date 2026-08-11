import type { SQLiteDatabase } from 'expo-sqlite';

import type {
  ReminderDispositionState,
  ReminderStrength,
  ReminderSyncStatus,
  ReminderType,
} from '../../../../contracts/reminder';
import type {
  OccurrenceOverrideAction,
  ReminderDispositionState as CloudReminderDispositionState,
  ScheduleKind,
  ScheduleStatus,
  ScheduleType,
} from '../../../../contracts/schedule';

export type LocalReminderDispositionState = ReminderDispositionState;
export type LocalReminderSyncStatus = ReminderSyncStatus;

export interface CloudScheduleRow {
  id: string;
  account_id: string;
  schedule_type: ScheduleType;
  schedule_kind: ScheduleKind;
  title: string;
  is_all_day: 0 | 1;
  start_time: string | null;
  end_time: string | null;
  timezone: string;
  recurrence_rule: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  reminder_type: ReminderType | null;
  reminder_trigger_at: string | null;
  reminder_offset_minutes: number | null;
  reminder_strength: ReminderStrength | null;
  reminder_disposition_state: CloudReminderDispositionState | null;
  status: ScheduleStatus;
  cloud_revision: number;
  updated_at: string;
}

export interface LocalScheduleRow extends Omit<CloudScheduleRow, 'reminder_disposition_state'> {
  reminder_disposition_state: LocalReminderDispositionState | null;
  next_trigger_at: string | null;
  snoozed_until: string | null;
  geofence_armed: 0 | 1;
  disposition_updated_at: string | null;
  sync_status: LocalReminderSyncStatus;
}

export type LocalReminderRuntimeUpdate = Pick<
  LocalScheduleRow,
  | 'reminder_disposition_state'
  | 'next_trigger_at'
  | 'snoozed_until'
  | 'geofence_armed'
  | 'disposition_updated_at'
  | 'sync_status'
>;

export interface LocalScheduleOccurrenceOverrideRow {
  id: string;
  schedule_id: string;
  occurrence_start: string;
  action: OccurrenceOverrideAction;
  replacement_schedule_id: string | null;
}

export class ScheduleLocalRepository {
  public constructor(private readonly database: SQLiteDatabase) {}

  public getSchedule(accountId: string, scheduleId: string): Promise<LocalScheduleRow | null> {
    return this.database.getFirstAsync<LocalScheduleRow>(
      `SELECT * FROM local_schedules WHERE account_id = ? AND id = ?`,
      accountId,
      scheduleId,
    );
  }

  public listSchedules(accountId: string): Promise<LocalScheduleRow[]> {
    return this.database.getAllAsync<LocalScheduleRow>(
      `SELECT *
       FROM local_schedules
       WHERE account_id = ?
       ORDER BY start_time, updated_at, id`,
      accountId,
    );
  }

  /** Apply cloud-owned fields while preserving existing device runtime state. */
  public async applyCloudSchedule(row: CloudScheduleRow): Promise<boolean> {
    const result = await this.database.runAsync(
      `INSERT INTO local_schedules (
         id, account_id, schedule_type, schedule_kind, title, is_all_day,
         start_time, end_time, timezone, recurrence_rule, location_name,
         latitude, longitude, reminder_type, reminder_trigger_at,
         reminder_offset_minutes, reminder_strength, reminder_disposition_state,
         next_trigger_at, snoozed_until, geofence_armed, disposition_updated_at,
         sync_status, status, cloud_revision, updated_at
       ) VALUES (
         $id, $account_id, $schedule_type, $schedule_kind, $title, $is_all_day,
         $start_time, $end_time, $timezone, $recurrence_rule, $location_name,
         $latitude, $longitude, $reminder_type, $reminder_trigger_at,
         $reminder_offset_minutes, $reminder_strength, $reminder_disposition_state,
         NULL, NULL, 0, NULL, 'synced', $status, $cloud_revision, $updated_at
       )
       ON CONFLICT(id) DO UPDATE SET
         schedule_type = excluded.schedule_type,
         schedule_kind = excluded.schedule_kind,
         title = excluded.title,
         is_all_day = excluded.is_all_day,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         timezone = excluded.timezone,
         recurrence_rule = excluded.recurrence_rule,
         location_name = excluded.location_name,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         reminder_type = excluded.reminder_type,
         reminder_trigger_at = excluded.reminder_trigger_at,
         reminder_offset_minutes = excluded.reminder_offset_minutes,
         reminder_strength = excluded.reminder_strength,
         status = excluded.status,
         cloud_revision = excluded.cloud_revision,
         updated_at = excluded.updated_at
       WHERE local_schedules.account_id = excluded.account_id`,
      {
        $id: row.id,
        $account_id: row.account_id,
        $schedule_type: row.schedule_type,
        $schedule_kind: row.schedule_kind,
        $title: row.title,
        $is_all_day: row.is_all_day,
        $start_time: row.start_time,
        $end_time: row.end_time,
        $timezone: row.timezone,
        $recurrence_rule: row.recurrence_rule,
        $location_name: row.location_name,
        $latitude: row.latitude,
        $longitude: row.longitude,
        $reminder_type: row.reminder_type,
        $reminder_trigger_at: row.reminder_trigger_at,
        $reminder_offset_minutes: row.reminder_offset_minutes,
        $reminder_strength: row.reminder_strength,
        $reminder_disposition_state: row.reminder_disposition_state,
        $status: row.status,
        $cloud_revision: row.cloud_revision,
        $updated_at: row.updated_at,
      },
    );
    return result.changes === 1;
  }

  /** Update only reminder state owned by the current device. */
  public async updateReminderRuntime(
    accountId: string,
    scheduleId: string,
    runtime: LocalReminderRuntimeUpdate,
  ): Promise<boolean> {
    const result = await this.database.runAsync(
      `UPDATE local_schedules SET
         reminder_disposition_state = $reminder_disposition_state,
         next_trigger_at = $next_trigger_at,
         snoozed_until = $snoozed_until,
         geofence_armed = $geofence_armed,
         disposition_updated_at = $disposition_updated_at,
         sync_status = $sync_status
       WHERE account_id = $account_id AND id = $id`,
      {
        $account_id: accountId,
        $id: scheduleId,
        $reminder_disposition_state: runtime.reminder_disposition_state,
        $next_trigger_at: runtime.next_trigger_at,
        $snoozed_until: runtime.snoozed_until,
        $geofence_armed: runtime.geofence_armed,
        $disposition_updated_at: runtime.disposition_updated_at,
        $sync_status: runtime.sync_status,
      },
    );
    return result.changes === 1;
  }

  /** Physically remove one local row for recovery or maintenance cleanup only. */
  public async purgeSchedule(accountId: string, scheduleId: string): Promise<boolean> {
    const result = await this.database.runAsync(
      `DELETE FROM local_schedules WHERE account_id = ? AND id = ?`,
      accountId,
      scheduleId,
    );
    return result.changes === 1;
  }

  public async upsertOccurrenceOverride(
    accountId: string,
    row: LocalScheduleOccurrenceOverrideRow,
  ): Promise<boolean> {
    const owner = await this.database.getFirstAsync<{ id: string }>(
      `SELECT id FROM local_schedules WHERE account_id = ? AND id = ?`,
      accountId,
      row.schedule_id,
    );
    if (owner === null) {
      return false;
    }
    if (row.replacement_schedule_id !== null) {
      const replacementOwner = await this.database.getFirstAsync<{ id: string }>(
        `SELECT id FROM local_schedules WHERE account_id = ? AND id = ?`,
        accountId,
        row.replacement_schedule_id,
      );
      if (replacementOwner === null) {
        return false;
      }
    }

    const result = await this.database.runAsync(
      `INSERT INTO local_schedule_occurrence_overrides (
         id, schedule_id, occurrence_start, action, replacement_schedule_id
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         occurrence_start = excluded.occurrence_start,
         action = excluded.action,
         replacement_schedule_id = excluded.replacement_schedule_id
       WHERE schedule_id = excluded.schedule_id`,
      row.id,
      row.schedule_id,
      row.occurrence_start,
      row.action,
      row.replacement_schedule_id,
    );
    return result.changes === 1;
  }

  public listOccurrenceOverrides(
    accountId: string,
    scheduleId?: string,
  ): Promise<LocalScheduleOccurrenceOverrideRow[]> {
    const scheduleFilter = scheduleId === undefined ? '' : 'AND overrides.schedule_id = ?';
    const parameters = scheduleId === undefined ? [accountId] : [accountId, scheduleId];
    return this.database.getAllAsync<LocalScheduleOccurrenceOverrideRow>(
      `SELECT
         overrides.id,
         overrides.schedule_id,
         overrides.occurrence_start,
         overrides.action,
         overrides.replacement_schedule_id
       FROM local_schedule_occurrence_overrides AS overrides
       INNER JOIN local_schedules AS schedules ON schedules.id = overrides.schedule_id
       WHERE schedules.account_id = ? ${scheduleFilter}
       ORDER BY overrides.occurrence_start, overrides.id`,
      parameters,
    );
  }
}
