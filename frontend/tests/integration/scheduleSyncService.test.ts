import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  CloudScheduleSnapshot,
  ScheduleOccurrenceOverrideSnapshot,
  ScheduleSnapshot,
} from '../../src/contracts/schedule';
import {
  ScheduleLocalRepository,
  type LocalReminderRuntimeUpdate,
} from '../../src/features/schedule/data';
import { SqliteScheduleSyncService } from '../../src/features/sync/application';
import { migrateScheduleDatabase } from '../../src/infrastructure/database/migrations';
import { SqlJsExpoDatabase } from '../helpers/sqliteTestDatabase';

function scheduleSnapshot(overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'once',
    title: 'Cloud schedule',
    is_all_day: false,
    start_time: '2026-08-17T02:00:00Z',
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    reminder_type: null,
    reminder_trigger_at: null,
    reminder_offset_minutes: null,
    reminder_strength: null,
    reminder_disposition_state: null,
    status: 'active',
    revision: 1,
    created_at: '2026-08-11T06:00:00Z',
    updated_at: '2026-08-11T07:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}

function replacementOverride(
  overrides: Partial<ScheduleOccurrenceOverrideSnapshot> = {},
): ScheduleOccurrenceOverrideSnapshot {
  return {
    id: 'override-a',
    schedule_id: 'series-a',
    occurrence_start: '2026-08-17T02:00:00Z',
    action: 'replace',
    replacement_schedule_id: 'replacement-a',
    created_at: '2026-08-11T07:00:00Z',
    updated_at: '2026-08-11T07:00:00Z',
    ...overrides,
  };
}

describe('SqliteScheduleSyncService', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;
  let repository: ScheduleLocalRepository;
  let service: SqliteScheduleSyncService;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await migrateScheduleDatabase(database.asSQLiteDatabase());
    repository = new ScheduleLocalRepository(database.asSQLiteDatabase());
    service = new SqliteScheduleSyncService(database.asSQLiteDatabase());
  });

  afterEach(() => {
    database.close();
  });

  it('atomically applies schedules before their replacement override', async () => {
    const snapshot: CloudScheduleSnapshot = {
      schedules: [
        scheduleSnapshot({
          id: 'series-a',
          schedule_kind: 'recurring',
          recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
        }),
        scheduleSnapshot({ id: 'replacement-a', start_time: '2026-08-17T06:00:00Z' }),
      ],
      occurrence_overrides: [replacementOverride()],
    };

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'message-a',
      accountId: 'account-a',
      snapshot,
    });

    expect(result).toEqual({
      messageId: 'message-a',
      status: 'applied',
      changedScheduleIds: ['series-a', 'replacement-a'],
    });
    expect(await repository.getSchedule('account-a', 'series-a')).toMatchObject({
      cloud_revision: 1,
      status: 'active',
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([
      {
        id: 'override-a',
        schedule_id: 'series-a',
        occurrence_start: '2026-08-17T02:00:00Z',
        action: 'replace',
        replacement_schedule_id: 'replacement-a',
      },
    ]);
  });

  it('preserves local reminder runtime while applying newer cloud fields and soft deletion', async () => {
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'initial',
      accountId: 'account-a',
      snapshot: { schedules: [scheduleSnapshot()], occurrence_overrides: [] },
    });
    const runtime: LocalReminderRuntimeUpdate = {
      reminder_disposition_state: 'snoozed',
      next_trigger_at: '2026-08-17T03:00:00Z',
      snoozed_until: '2026-08-17T03:00:00Z',
      geofence_armed: 1,
      disposition_updated_at: '2026-08-17T02:30:00Z',
      sync_status: 'pending',
    };
    await repository.updateReminderRuntime('account-a', 'schedule-a', runtime);

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'delete',
      accountId: 'account-a',
      snapshot: {
        schedules: [
          scheduleSnapshot({
            title: 'Deleted in cloud',
            status: 'deleted',
            revision: 2,
            updated_at: '2026-08-11T08:00:00Z',
            deleted_at: '2026-08-11T08:00:00Z',
          }),
        ],
        occurrence_overrides: [],
      },
    });

    expect(result.status).toBe('applied');
    expect(await repository.getSchedule('account-a', 'schedule-a')).toMatchObject({
      title: 'Deleted in cloud',
      status: 'deleted',
      cloud_revision: 2,
      ...runtime,
    });
  });

  it('restores missing schedules and overrides when another snapshot member is stale', async () => {
    const current = scheduleSnapshot({
      id: 'series-a',
      schedule_kind: 'recurring',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      revision: 2,
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'current',
      accountId: 'account-a',
      snapshot: { schedules: [current], occurrence_overrides: [] },
    });

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'stale',
      accountId: 'account-a',
      snapshot: {
        schedules: [
          { ...current, title: 'Stale title', revision: 1 },
          scheduleSnapshot({
            id: 'series-b',
            schedule_kind: 'recurring',
            recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
          }),
        ],
        occurrence_overrides: [
          replacementOverride({
            id: 'override-b',
            schedule_id: 'series-b',
            action: 'cancel',
            replacement_schedule_id: null,
          }),
        ],
      },
    });

    expect(result).toEqual({
      messageId: 'stale',
      status: 'applied',
      changedScheduleIds: ['series-b'],
    });
    expect(await repository.getSchedule('account-a', 'series-a')).toMatchObject({
      title: 'Cloud schedule',
      cloud_revision: 2,
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([]);
    expect(await repository.listOccurrenceOverrides('account-a', 'series-b')).toEqual([
      {
        id: 'override-b',
        schedule_id: 'series-b',
        occurrence_start: '2026-08-17T02:00:00Z',
        action: 'cancel',
        replacement_schedule_id: null,
      },
    ]);
  });

  it('does not let a stale parent snapshot overwrite a newer local override', async () => {
    const current = scheduleSnapshot({
      id: 'series-a',
      schedule_kind: 'recurring',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      revision: 3,
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'current',
      accountId: 'account-a',
      snapshot: {
        schedules: [
          current,
          scheduleSnapshot({ id: 'replacement-a', start_time: '2026-08-17T06:00:00Z' }),
        ],
        occurrence_overrides: [
          replacementOverride({ action: 'cancel', replacement_schedule_id: null }),
        ],
      },
    });

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'stale-parent',
      accountId: 'account-a',
      snapshot: {
        schedules: [{ ...current, title: 'Stale title', revision: 2 }],
        occurrence_overrides: [replacementOverride()],
      },
    });

    expect(result).toEqual({
      messageId: 'stale-parent',
      status: 'ignored_stale',
      changedScheduleIds: [],
    });
    expect(await repository.getSchedule('account-a', 'series-a')).toMatchObject({
      title: 'Cloud schedule',
      cloud_revision: 3,
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([
      expect.objectContaining({ action: 'cancel', replacement_schedule_id: null }),
    ]);
  });

  it('applies a newer parent schedule and its changed override together', async () => {
    const parent = scheduleSnapshot({
      id: 'series-a',
      schedule_kind: 'recurring',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      revision: 2,
    });
    const replacement = scheduleSnapshot({
      id: 'replacement-a',
      start_time: '2026-08-17T06:00:00Z',
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'older',
      accountId: 'account-a',
      snapshot: {
        schedules: [parent, replacement],
        occurrence_overrides: [
          replacementOverride({ action: 'cancel', replacement_schedule_id: null }),
        ],
      },
    });

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'newer',
      accountId: 'account-a',
      snapshot: {
        schedules: [{ ...parent, title: 'Revision three', revision: 3 }],
        occurrence_overrides: [replacementOverride()],
      },
    });

    expect(result).toEqual({
      messageId: 'newer',
      status: 'applied',
      changedScheduleIds: ['series-a'],
    });
    expect(await repository.getSchedule('account-a', 'series-a')).toMatchObject({
      title: 'Revision three',
      cloud_revision: 3,
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([
      expect.objectContaining({ action: 'replace', replacement_schedule_id: 'replacement-a' }),
    ]);
  });

  it('is idempotent for the same revision and identical override', async () => {
    const snapshot: CloudScheduleSnapshot = {
      schedules: [
        scheduleSnapshot({
          id: 'series-a',
          schedule_kind: 'recurring',
          recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
        }),
        scheduleSnapshot({ id: 'replacement-a', start_time: '2026-08-17T06:00:00Z' }),
      ],
      occurrence_overrides: [replacementOverride()],
    };
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'first',
      accountId: 'account-a',
      snapshot,
    });
    const beforeReplay = await database.getFirstAsync<{ changes: number }>(
      'SELECT total_changes() AS changes',
    );

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'duplicate',
      accountId: 'account-a',
      snapshot,
    });

    expect(result).toEqual({
      messageId: 'duplicate',
      status: 'ignored_stale',
      changedScheduleIds: [],
    });
    const afterReplay = await database.getFirstAsync<{ changes: number }>(
      'SELECT total_changes() AS changes',
    );
    expect(afterReplay?.changes).toBe(beforeReplay?.changes);
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toHaveLength(1);
  });

  it('does not overwrite a different local override at the same parent revision', async () => {
    const parent = scheduleSnapshot({
      id: 'series-a',
      schedule_kind: 'recurring',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      revision: 3,
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'local-view',
      accountId: 'account-a',
      snapshot: {
        schedules: [
          parent,
          scheduleSnapshot({ id: 'replacement-a', start_time: '2026-08-17T06:00:00Z' }),
        ],
        occurrence_overrides: [
          replacementOverride({ action: 'cancel', replacement_schedule_id: null }),
        ],
      },
    });

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'same-revision-different-override',
      accountId: 'account-a',
      snapshot: {
        schedules: [parent],
        occurrence_overrides: [replacementOverride()],
      },
    });

    expect(result).toEqual({
      messageId: 'same-revision-different-override',
      status: 'ignored_stale',
      changedScheduleIds: [],
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([
      expect.objectContaining({ action: 'cancel', replacement_schedule_id: null }),
    ]);
  });

  it('repairs a missing override at the same parent revision without rewriting the schedule', async () => {
    const parent = scheduleSnapshot({
      id: 'series-a',
      schedule_kind: 'recurring',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      revision: 2,
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'parent-only',
      accountId: 'account-a',
      snapshot: { schedules: [parent], occurrence_overrides: [] },
    });

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'recovery',
      accountId: 'account-a',
      snapshot: {
        schedules: [parent],
        occurrence_overrides: [
          replacementOverride({ action: 'cancel', replacement_schedule_id: null }),
        ],
      },
    });

    expect(result).toEqual({
      messageId: 'recovery',
      status: 'applied',
      changedScheduleIds: ['series-a'],
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toHaveLength(1);
  });

  it('does not insert a missing override from a stale parent snapshot', async () => {
    const current = scheduleSnapshot({
      id: 'series-a',
      schedule_kind: 'recurring',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      revision: 5,
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'current',
      accountId: 'account-a',
      snapshot: { schedules: [current], occurrence_overrides: [] },
    });

    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'stale-missing-override',
      accountId: 'account-a',
      snapshot: {
        schedules: [{ ...current, revision: 4 }],
        occurrence_overrides: [
          replacementOverride({ action: 'cancel', replacement_schedule_id: null }),
        ],
      },
    });

    expect(result).toEqual({
      messageId: 'stale-missing-override',
      status: 'ignored_stale',
      changedScheduleIds: [],
    });
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([]);
  });

  it('reports account mismatch for cloud ownership and existing local ID collisions', async () => {
    const cloudMismatch = await service.applyScheduleSnapshotToSqlite({
      messageId: 'cloud-mismatch',
      accountId: 'account-a',
      snapshot: {
        schedules: [scheduleSnapshot({ account_id: 'account-b' })],
        occurrence_overrides: [],
      },
    });
    await service.applyScheduleSnapshotToSqlite({
      messageId: 'seed-account-b',
      accountId: 'account-b',
      snapshot: {
        schedules: [scheduleSnapshot({ account_id: 'account-b' })],
        occurrence_overrides: [],
      },
    });
    const localCollision = await service.applyScheduleSnapshotToSqlite({
      messageId: 'local-collision',
      accountId: 'account-a',
      snapshot: { schedules: [scheduleSnapshot()], occurrence_overrides: [] },
    });

    expect(cloudMismatch).toMatchObject({ status: 'failed', errorCode: 'account_mismatch' });
    expect(localCollision).toMatchObject({ status: 'failed', errorCode: 'account_mismatch' });
    expect(await repository.getSchedule('account-b', 'schedule-a')).not.toBeNull();
    expect(await repository.getSchedule('account-a', 'schedule-a')).toBeNull();
  });

  it('rejects invalid snapshots before writing and rolls back SQLite failures', async () => {
    const invalid = await service.applyScheduleSnapshotToSqlite({
      messageId: 'invalid',
      accountId: 'account-a',
      snapshot: {
        schedules: [scheduleSnapshot({ revision: 0 })],
        occurrence_overrides: [],
      },
    });
    const rollback = await service.applyScheduleSnapshotToSqlite({
      messageId: 'rollback',
      accountId: 'account-a',
      snapshot: {
        schedules: [
          scheduleSnapshot({
            id: 'series-a',
            schedule_kind: 'recurring',
            recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
          }),
        ],
        occurrence_overrides: [replacementOverride()],
      },
    });

    expect(invalid).toMatchObject({ status: 'failed', errorCode: 'invalid_snapshot' });
    expect(rollback).toMatchObject({
      status: 'failed',
      errorCode: 'sqlite_transaction_failed',
    });
    expect(await repository.getSchedule('account-a', 'series-a')).toBeNull();
  });

  it('rejects recurrence sets instead of accepting non-RRULE snapshot content', async () => {
    const result = await service.applyScheduleSnapshotToSqlite({
      messageId: 'invalid-recurrence',
      accountId: 'account-a',
      snapshot: {
        schedules: [
          scheduleSnapshot({
            schedule_kind: 'recurring',
            recurrence_rule: 'RDATE:20260817T020000Z',
          }),
        ],
        occurrence_overrides: [],
      },
    });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'invalid_snapshot' });
    expect(await repository.getSchedule('account-a', 'schedule-a')).toBeNull();
  });
});
