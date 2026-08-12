import type { SQLiteDatabase } from 'expo-sqlite';

import type {
  CloudScheduleSnapshot,
  ScheduleOccurrenceOverrideSnapshot,
  ScheduleSnapshot,
} from '../../../contracts/schedule';
import {
  ScheduleLocalRepository,
  type CloudScheduleRow,
  type LocalScheduleOccurrenceOverrideRow,
} from '../../schedule/data';
import {
  instantToZonedParts,
  isValidIanaTimezone,
  localPartsToFloatingDate,
  parseIsoInstant,
} from '../../schedule/domain/scheduleDateTime';
import {
  normalizeUtcUntilForFloatingRrule,
  parseScheduleRrule,
} from '../../schedule/domain/scheduleRecurrence';

/** WebSocket result passed to the local synchronization boundary. */
export interface ApplyScheduleSnapshotCommand {
  messageId: string;
  accountId: string;
  snapshot: CloudScheduleSnapshot;
}

export type SnapshotApplyStatus = 'applied' | 'ignored_stale' | 'failed';

export type SnapshotApplyErrorCode =
  'invalid_snapshot' | 'account_mismatch' | 'sqlite_transaction_failed';

/** Successful or stale result for which the WebSocket owner can send an ACK. */
export interface SnapshotApplySuccessResult {
  messageId: string;
  status: Exclude<SnapshotApplyStatus, 'failed'>;
  changedScheduleIds: readonly string[];
}

/** Failed local transaction result for which the WebSocket owner must not ACK. */
export interface SnapshotApplyFailureResult {
  messageId: string;
  status: 'failed';
  changedScheduleIds: readonly string[];
  errorCode: SnapshotApplyErrorCode;
}

/** Result used by the WebSocket owner to decide whether an ACK can be sent. */
export type SnapshotApplyResult = SnapshotApplySuccessResult | SnapshotApplyFailureResult;

/** Apply server-confirmed schedule snapshots to the local SQLite projection. */
export interface ScheduleSyncService {
  /**
   * Apply every confirmed create, update, delete, and recurrence change.
   *
   * Schedules and occurrence overrides are committed in one SQLite transaction;
   * duplicate or stale confirmed results are acknowledged without rewriting.
   */
  applyScheduleSnapshotToSqlite(
    command: ApplyScheduleSnapshotCommand,
  ): Promise<SnapshotApplyResult>;
}

class LocalAccountMismatchError extends Error {}

/** SQLite implementation of the stable confirmed-snapshot application boundary. */
export class SqliteScheduleSyncService implements ScheduleSyncService {
  public constructor(private readonly database: SQLiteDatabase) {}

  public async applyScheduleSnapshotToSqlite(
    command: ApplyScheduleSnapshotCommand,
  ): Promise<SnapshotApplyResult> {
    const errorCode = validateCommand(command);
    if (errorCode !== null) {
      return failed(command.messageId, errorCode);
    }

    const changedScheduleIds = new Set<string>();
    try {
      await this.database.withExclusiveTransactionAsync(async (transaction) => {
        const existingRows = await loadExistingRows(transaction, command.snapshot.schedules);
        const schedulesToApply: ScheduleSnapshot[] = [];
        const freshnessBySchedule = new Map<string, ScheduleFreshness>();
        for (const schedule of command.snapshot.schedules) {
          const existing = existingRows.get(schedule.id);
          if (existing !== undefined && existing.account_id !== command.accountId) {
            throw new LocalAccountMismatchError();
          }
          if (existing === undefined || existing.cloud_revision < schedule.revision) {
            schedulesToApply.push(schedule);
            freshnessBySchedule.set(schedule.id, 'newer');
          } else if (existing.cloud_revision === schedule.revision) {
            freshnessBySchedule.set(schedule.id, 'same');
          } else {
            freshnessBySchedule.set(schedule.id, 'stale');
          }
        }
        await assertReferencedRowsDoNotCrossAccount(transaction, command);

        const repository = new ScheduleLocalRepository(transaction);
        for (const schedule of schedulesToApply) {
          if (!(await repository.applyCloudSchedule(toCloudRow(schedule)))) {
            throw new Error(`Could not apply cloud schedule ${schedule.id}`);
          }
          changedScheduleIds.add(schedule.id);
        }
        for (const override of command.snapshot.occurrence_overrides) {
          const freshness = freshnessBySchedule.get(override.schedule_id);
          if (
            freshness === undefined ||
            !(await shouldApplyOverride(transaction, command.accountId, override, freshness))
          ) {
            continue;
          }
          if (
            !(await repository.upsertOccurrenceOverride(
              command.accountId,
              toLocalOverride(override),
            ))
          ) {
            throw new Error(`Could not apply occurrence override ${override.id}`);
          }
          changedScheduleIds.add(override.schedule_id);
        }
      });
    } catch (error) {
      return failed(
        command.messageId,
        error instanceof LocalAccountMismatchError
          ? 'account_mismatch'
          : 'sqlite_transaction_failed',
      );
    }

    return {
      messageId: command.messageId,
      status: changedScheduleIds.size === 0 ? 'ignored_stale' : 'applied',
      changedScheduleIds: [...changedScheduleIds],
    };
  }
}

function validateCommand(command: ApplyScheduleSnapshotCommand): SnapshotApplyErrorCode | null {
  if (command.messageId.trim().length === 0 || command.accountId.trim().length === 0) {
    return 'invalid_snapshot';
  }
  if (command.snapshot.schedules.some((schedule) => schedule.account_id !== command.accountId)) {
    return 'account_mismatch';
  }
  if (command.snapshot.schedules.length === 0) {
    return 'invalid_snapshot';
  }
  const scheduleIds = new Set<string>();
  for (const schedule of command.snapshot.schedules) {
    if (scheduleIds.has(schedule.id) || !isValidSchedule(schedule)) {
      return 'invalid_snapshot';
    }
    scheduleIds.add(schedule.id);
  }
  const overrideIds = new Set<string>();
  const occurrenceKeys = new Set<string>();
  for (const override of command.snapshot.occurrence_overrides) {
    const occurrenceKey = `${override.schedule_id}\u0000${override.occurrence_start}`;
    if (
      overrideIds.has(override.id) ||
      occurrenceKeys.has(occurrenceKey) ||
      !scheduleIds.has(override.schedule_id) ||
      !isValidOverride(override)
    ) {
      return 'invalid_snapshot';
    }
    overrideIds.add(override.id);
    occurrenceKeys.add(occurrenceKey);
  }
  return null;
}

function isValidSchedule(schedule: ScheduleSnapshot): boolean {
  const start = parseIsoInstant(schedule.start_time);
  const end = parseIsoInstant(schedule.end_time);
  const created = parseIsoInstant(schedule.created_at);
  const updated = parseIsoInstant(schedule.updated_at);
  const deleted = parseIsoInstant(schedule.deleted_at);
  const reminderTrigger = parseIsoInstant(schedule.reminder_trigger_at);
  if (
    !['time', 'location'].includes(schedule.schedule_type) ||
    !['once', 'recurring'].includes(schedule.schedule_kind) ||
    !['active', 'deleted'].includes(schedule.status) ||
    schedule.id.trim().length === 0 ||
    schedule.id.length > 64 ||
    schedule.account_id.trim().length === 0 ||
    schedule.account_id.length > 64 ||
    schedule.title.trim().length === 0 ||
    schedule.title.length > 255 ||
    !Number.isInteger(schedule.revision) ||
    schedule.revision < 1 ||
    created === null ||
    updated === null ||
    !isValidIanaTimezone(schedule.timezone)
  ) {
    return false;
  }
  if (
    (schedule.latitude === null) !== (schedule.longitude === null) ||
    (schedule.latitude !== null && (schedule.latitude < -90 || schedule.latitude > 90)) ||
    (schedule.longitude !== null && (schedule.longitude < -180 || schedule.longitude > 180))
  ) {
    return false;
  }
  if (schedule.status === 'active' ? schedule.deleted_at !== null : deleted === null) {
    return false;
  }
  if (schedule.schedule_type === 'time' ? start === null : start !== null) {
    return false;
  }
  if (
    schedule.schedule_type === 'location' &&
    (schedule.is_all_day || schedule.latitude === null || schedule.longitude === null)
  ) {
    return false;
  }
  if (
    schedule.schedule_kind === 'recurring'
      ? schedule.schedule_type !== 'time' || schedule.recurrence_rule === null
      : schedule.recurrence_rule !== null
  ) {
    return false;
  }
  if (schedule.is_all_day && (start === null || end === null)) {
    return false;
  }
  if (
    schedule.is_all_day &&
    start !== null &&
    end !== null &&
    (!isLocalMidnight(start, schedule.timezone) || !isLocalMidnight(end, schedule.timezone))
  ) {
    return false;
  }
  if (end !== null && (start === null || end <= start)) {
    return false;
  }
  if (schedule.reminder_trigger_at !== null && reminderTrigger === null) {
    return false;
  }
  if (
    schedule.schedule_kind === 'recurring' &&
    start !== null &&
    schedule.recurrence_rule !== null
  ) {
    try {
      parseScheduleRrule(
        normalizeUtcUntilForFloatingRrule(schedule.recurrence_rule, schedule.timezone),
        localPartsToFloatingDate(instantToZonedParts(start, schedule.timezone)),
      );
    } catch {
      return false;
    }
  }
  return isValidReminder(schedule);
}

function isValidReminder(schedule: ScheduleSnapshot): boolean {
  if (
    schedule.reminder_disposition_state !== null &&
    schedule.reminder_disposition_state !== 'confirmed'
  ) {
    return false;
  }
  if (schedule.reminder_type === null) {
    return (
      schedule.reminder_trigger_at === null &&
      schedule.reminder_offset_minutes === null &&
      schedule.reminder_strength === null
    );
  }
  if (
    !['at_time', 'before_start', 'arrive_location', 'return_to_recorded_location'].includes(
      schedule.reminder_type,
    )
  ) {
    return false;
  }
  if (schedule.reminder_strength === null) {
    return false;
  }
  if (!['low', 'medium', 'high'].includes(schedule.reminder_strength)) {
    return false;
  }
  if (schedule.reminder_type === 'at_time') {
    return (
      schedule.schedule_type === 'time' &&
      schedule.reminder_trigger_at !== null &&
      schedule.reminder_offset_minutes === null
    );
  }
  if (schedule.reminder_type === 'before_start') {
    return (
      schedule.schedule_type === 'time' &&
      schedule.reminder_trigger_at === null &&
      schedule.reminder_offset_minutes !== null &&
      Number.isInteger(schedule.reminder_offset_minutes) &&
      schedule.reminder_offset_minutes >= 0
    );
  }
  return (
    schedule.reminder_trigger_at === null &&
    schedule.reminder_offset_minutes === null &&
    schedule.latitude !== null &&
    schedule.longitude !== null
  );
}

function isLocalMidnight(value: Date, timezone: string): boolean {
  const local = instantToZonedParts(value, timezone);
  return local.hour === 0 && local.minute === 0 && local.second === 0 && local.millisecond === 0;
}

function isValidOverride(override: ScheduleOccurrenceOverrideSnapshot): boolean {
  return (
    ['cancel', 'replace'].includes(override.action) &&
    override.id.trim().length > 0 &&
    override.id.length <= 64 &&
    override.schedule_id.trim().length > 0 &&
    override.schedule_id.length <= 64 &&
    (override.replacement_schedule_id === null ||
      (override.replacement_schedule_id.trim().length > 0 &&
        override.replacement_schedule_id.length <= 64)) &&
    parseIsoInstant(override.occurrence_start) !== null &&
    parseIsoInstant(override.created_at) !== null &&
    parseIsoInstant(override.updated_at) !== null &&
    (override.action === 'replace'
      ? override.replacement_schedule_id !== null
      : override.replacement_schedule_id === null)
  );
}

type ScheduleFreshness = 'newer' | 'same' | 'stale';

async function shouldApplyOverride(
  database: SQLiteDatabase,
  accountId: string,
  incoming: ScheduleOccurrenceOverrideSnapshot,
  parentFreshness: ScheduleFreshness,
): Promise<boolean> {
  if (parentFreshness === 'stale') {
    return false;
  }
  const existing = await loadMatchingOverrides(database, accountId, incoming);
  if (existing.some((row) => overrideMatchesSnapshot(row, incoming))) {
    return false;
  }
  // Equal-revision snapshots may repair a missing row, but must never replace a
  // different local value whose freshness cannot be distinguished separately.
  return parentFreshness === 'newer' || existing.length === 0;
}

async function loadMatchingOverrides(
  database: SQLiteDatabase,
  accountId: string,
  incoming: ScheduleOccurrenceOverrideSnapshot,
): Promise<LocalScheduleOccurrenceOverrideRow[]> {
  return database.getAllAsync<LocalScheduleOccurrenceOverrideRow>(
    `SELECT overrides.id, overrides.schedule_id, overrides.occurrence_start,
            overrides.action, overrides.replacement_schedule_id
     FROM local_schedule_occurrence_overrides AS overrides
     INNER JOIN local_schedules AS schedules ON schedules.id = overrides.schedule_id
     WHERE schedules.account_id = ?
       AND (
         overrides.id = ?
         OR (overrides.schedule_id = ? AND overrides.occurrence_start = ?)
       )`,
    accountId,
    incoming.id,
    incoming.schedule_id,
    incoming.occurrence_start,
  );
}

function overrideMatchesSnapshot(
  existing: LocalScheduleOccurrenceOverrideRow,
  incoming: ScheduleOccurrenceOverrideSnapshot,
): boolean {
  return (
    existing.id === incoming.id &&
    existing.schedule_id === incoming.schedule_id &&
    existing.occurrence_start === incoming.occurrence_start &&
    existing.action === incoming.action &&
    existing.replacement_schedule_id === incoming.replacement_schedule_id
  );
}

async function loadExistingRows(
  database: SQLiteDatabase,
  schedules: readonly ScheduleSnapshot[],
): Promise<Map<string, { account_id: string; cloud_revision: number }>> {
  const rows = new Map<string, { account_id: string; cloud_revision: number }>();
  for (const schedule of schedules) {
    const existing = await database.getFirstAsync<{
      account_id: string;
      cloud_revision: number;
    }>(`SELECT account_id, cloud_revision FROM local_schedules WHERE id = ?`, schedule.id);
    if (existing !== null) {
      rows.set(schedule.id, existing);
    }
  }
  return rows;
}

async function assertReferencedRowsDoNotCrossAccount(
  database: SQLiteDatabase,
  command: ApplyScheduleSnapshotCommand,
): Promise<void> {
  const referencedIds = new Set<string>();
  for (const override of command.snapshot.occurrence_overrides) {
    referencedIds.add(override.schedule_id);
    if (override.replacement_schedule_id !== null) {
      referencedIds.add(override.replacement_schedule_id);
    }
  }
  for (const scheduleId of referencedIds) {
    const existing = await database.getFirstAsync<{ account_id: string }>(
      `SELECT account_id FROM local_schedules WHERE id = ?`,
      scheduleId,
    );
    if (existing !== null && existing.account_id !== command.accountId) {
      throw new LocalAccountMismatchError();
    }
  }
}

function toCloudRow(schedule: ScheduleSnapshot): CloudScheduleRow {
  return {
    id: schedule.id,
    account_id: schedule.account_id,
    schedule_type: schedule.schedule_type,
    schedule_kind: schedule.schedule_kind,
    title: schedule.title,
    is_all_day: schedule.is_all_day ? 1 : 0,
    start_time: schedule.start_time,
    end_time: schedule.end_time,
    timezone: schedule.timezone,
    recurrence_rule: schedule.recurrence_rule,
    location_name: schedule.location_name,
    latitude: schedule.latitude,
    longitude: schedule.longitude,
    reminder_type: schedule.reminder_type,
    reminder_trigger_at: schedule.reminder_trigger_at,
    reminder_offset_minutes: schedule.reminder_offset_minutes,
    reminder_strength: schedule.reminder_strength,
    reminder_disposition_state: schedule.reminder_disposition_state,
    status: schedule.status,
    cloud_revision: schedule.revision,
    updated_at: schedule.updated_at,
  };
}

function toLocalOverride(
  override: ScheduleOccurrenceOverrideSnapshot,
): LocalScheduleOccurrenceOverrideRow {
  return {
    id: override.id,
    schedule_id: override.schedule_id,
    occurrence_start: override.occurrence_start,
    action: override.action,
    replacement_schedule_id: override.replacement_schedule_id,
  };
}

function failed(messageId: string, errorCode: SnapshotApplyErrorCode): SnapshotApplyFailureResult {
  return {
    messageId,
    status: 'failed',
    changedScheduleIds: [],
    errorCode,
  };
}
