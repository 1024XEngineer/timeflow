import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ScheduleLocalRepository,
  type CloudScheduleRow,
  type LocalReminderRuntimeUpdate,
  type LocalScheduleOccurrenceOverrideRow,
} from '../../src/features/schedule/data';
import {
  CURRENT_DATABASE_VERSION,
  migrateScheduleDatabase,
} from '../../src/infrastructure/database/migrations';
import { SqlJsExpoDatabase } from '../helpers/sqliteTestDatabase';

function cloudSchedule(overrides: Partial<CloudScheduleRow> = {}): CloudScheduleRow {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'once',
    title: 'Original title',
    is_all_day: 0,
    start_time: '2026-08-12T07:00:00Z',
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    reminder_type: 'before_start',
    reminder_trigger_at: null,
    reminder_offset_minutes: 15,
    reminder_strength: 'medium',
    reminder_disposition_state: null,
    status: 'active',
    cloud_revision: 1,
    updated_at: '2026-08-11T07:00:00Z',
    ...overrides,
  };
}

function snoozedRuntime(): LocalReminderRuntimeUpdate {
  return {
    reminder_disposition_state: 'snoozed',
    next_trigger_at: '2026-08-12T07:30:00Z',
    snoozed_until: '2026-08-12T07:30:00Z',
    geofence_armed: 1,
    disposition_updated_at: '2026-08-12T07:20:00Z',
    sync_status: 'pending',
  };
}

describe('ScheduleLocalRepository SQLite behavior', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;
  let repository: ScheduleLocalRepository;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await migrateScheduleDatabase(database.asSQLiteDatabase());
    repository = new ScheduleLocalRepository(database.asSQLiteDatabase());
  });

  afterEach(() => {
    database.close();
  });

  it('runs the migration and records the current schema version', async () => {
    await migrateScheduleDatabase(database.asSQLiteDatabase());

    const version = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const tables = await database.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'local_%'
       ORDER BY name`,
    );

    expect(version?.user_version).toBe(CURRENT_DATABASE_VERSION);
    expect(tables.map((table) => table.name)).toEqual([
      'local_schedule_occurrence_overrides',
      'local_schedules',
    ]);
  });

  it('inserts a cloud schedule with safe local runtime defaults', async () => {
    expect(await repository.applyCloudSchedule(cloudSchedule())).toBe(true);

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored).toMatchObject({
      title: 'Original title',
      cloud_revision: 1,
      reminder_disposition_state: null,
      next_trigger_at: null,
      snoozed_until: null,
      geofence_armed: 0,
      disposition_updated_at: null,
      sync_status: 'synced',
      status: 'active',
    });
  });

  it('applies cloud fields without overwriting device runtime state', async () => {
    await repository.applyCloudSchedule(cloudSchedule());
    await repository.updateReminderRuntime('account-a', 'schedule-a', snoozedRuntime());

    expect(
      await repository.applyCloudSchedule(
        cloudSchedule({
          title: 'Cloud update',
          reminder_disposition_state: 'confirmed',
          cloud_revision: 2,
          updated_at: '2026-08-11T08:00:00Z',
        }),
      ),
    ).toBe(true);

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored).toMatchObject({
      title: 'Cloud update',
      cloud_revision: 2,
      updated_at: '2026-08-11T08:00:00Z',
      ...snoozedRuntime(),
    });
  });

  it('updates only local runtime fields and enforces account isolation', async () => {
    const cloud = cloudSchedule();
    await repository.applyCloudSchedule(cloud);

    expect(
      await repository.applyCloudSchedule(
        cloudSchedule({ account_id: 'account-b', title: 'Cross-account cloud update' }),
      ),
    ).toBe(false);
    expect(await repository.updateReminderRuntime('account-b', cloud.id, snoozedRuntime())).toBe(
      false,
    );
    expect(await repository.updateReminderRuntime('account-a', cloud.id, snoozedRuntime())).toBe(
      true,
    );

    const stored = await repository.getSchedule('account-a', cloud.id);
    expect(stored).toMatchObject({
      title: cloud.title,
      start_time: cloud.start_time,
      status: cloud.status,
      cloud_revision: cloud.cloud_revision,
      updated_at: cloud.updated_at,
      ...snoozedRuntime(),
    });
  });

  it('stores cloud soft deletion and purges only through the explicit cleanup API', async () => {
    await repository.applyCloudSchedule(cloudSchedule());

    expect(
      await repository.applyCloudSchedule(
        cloudSchedule({
          status: 'deleted',
          cloud_revision: 2,
          updated_at: '2026-08-11T08:00:00Z',
        }),
      ),
    ).toBe(true);
    expect(await repository.getSchedule('account-a', 'schedule-a')).toMatchObject({
      status: 'deleted',
      cloud_revision: 2,
    });

    expect(await repository.purgeSchedule('account-b', 'schedule-a')).toBe(false);
    expect(await repository.purgeSchedule('account-a', 'schedule-a')).toBe(true);
    expect(await repository.getSchedule('account-a', 'schedule-a')).toBeNull();
  });

  it('enforces override actions, uniqueness, ownership, and foreign keys', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({ id: 'series-a', schedule_kind: 'recurring', recurrence_rule: 'FREQ=DAILY' }),
    );
    await repository.applyCloudSchedule(cloudSchedule({ id: 'replacement-a' }));
    await repository.applyCloudSchedule(
      cloudSchedule({ id: 'replacement-b', account_id: 'account-b' }),
    );
    const cancel: LocalScheduleOccurrenceOverrideRow = {
      id: 'override-a',
      schedule_id: 'series-a',
      occurrence_start: '2026-08-13T07:00:00Z',
      action: 'cancel',
      replacement_schedule_id: null,
    };

    expect(await repository.upsertOccurrenceOverride('account-a', cancel)).toBe(true);
    expect(
      await repository.upsertOccurrenceOverride('account-a', {
        ...cancel,
        action: 'replace',
        replacement_schedule_id: 'replacement-a',
      }),
    ).toBe(true);
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([
      {
        ...cancel,
        action: 'replace',
        replacement_schedule_id: 'replacement-a',
      },
    ]);

    await expect(
      repository.upsertOccurrenceOverride('account-a', {
        ...cancel,
        id: 'override-duplicate',
      }),
    ).rejects.toThrow();
    expect(
      await repository.upsertOccurrenceOverride('account-a', {
        ...cancel,
        id: 'override-cross-account',
        action: 'replace',
        replacement_schedule_id: 'replacement-b',
      }),
    ).toBe(false);

    await expect(repository.purgeSchedule('account-a', 'replacement-a')).rejects.toThrow();
    expect(await repository.purgeSchedule('account-a', 'series-a')).toBe(true);
    expect(await repository.listOccurrenceOverrides('account-a', 'series-a')).toEqual([]);
    expect(await repository.purgeSchedule('account-a', 'replacement-a')).toBe(true);
  });
});
