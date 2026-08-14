import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScheduleLocalRepository, type CloudScheduleRow } from '../../src/features/schedule/data';
import { SqliteLocalScheduleReader } from '../../src/features/reminder/data/local/SqliteLocalScheduleReader';
import { migrateScheduleDatabase } from '../../src/infrastructure/database/migrations';
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

describe('SqliteLocalScheduleReader', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;
  let repository: ScheduleLocalRepository;
  let reader: SqliteLocalScheduleReader;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await migrateScheduleDatabase(database.asSQLiteDatabase());
    repository = new ScheduleLocalRepository(database.asSQLiteDatabase());
    reader = new SqliteLocalScheduleReader();
  });

  afterEach(() => {
    database.close();
  });

  it('returns nothing before attach()', async () => {
    expect(await reader.listReminderSchedules()).toEqual([]);
    expect(await reader.getReminderSchedule('schedule-a')).toBeNull();
  });

  it('maps a stored row onto the reminder domain shape once attached', async () => {
    await repository.applyCloudSchedule(cloudSchedule());
    reader.attach(repository, 'account-a');

    const schedules = await reader.listReminderSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      id: 'schedule-a',
      account_id: 'account-a',
      title: 'Original title',
      geofence_radius_meters: 200,
      reminder: {
        reminder_type: 'before_start',
        reminder_offset_minutes: 15,
        reminder_strength: 'medium',
      },
      runtime: {
        geofence_armed: false,
        recorded_location: null,
        sync_status: 'synced',
      },
      status: 'active',
    });

    expect(await reader.getReminderSchedule('schedule-a')).toMatchObject({ id: 'schedule-a' });
    expect(await reader.getReminderSchedule('missing')).toBeNull();
  });

  it('scopes reads to the attached account', async () => {
    await repository.applyCloudSchedule(cloudSchedule());
    reader.attach(repository, 'account-b');

    expect(await reader.listReminderSchedules()).toEqual([]);
  });

  it('stops returning data after detach()', async () => {
    await repository.applyCloudSchedule(cloudSchedule());
    reader.attach(repository, 'account-a');
    expect(await reader.listReminderSchedules()).toHaveLength(1);

    reader.detach();

    expect(await reader.listReminderSchedules()).toEqual([]);
  });

  it('notifies subscribers with a fresh read on refresh()', async () => {
    reader.attach(repository, 'account-a');
    const listener = vi.fn();
    reader.subscribe(listener);

    await repository.applyCloudSchedule(cloudSchedule());
    await reader.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    const [notified] = listener.mock.calls[0] as [readonly { id: string }[]];
    expect(notified).toHaveLength(1);
    expect(notified[0].id).toBe('schedule-a');
  });

  it('stops notifying an unsubscribed listener', async () => {
    reader.attach(repository, 'account-a');
    const listener = vi.fn();
    const unsubscribe = reader.subscribe(listener);
    unsubscribe();

    await repository.applyCloudSchedule(cloudSchedule());
    await reader.refresh();

    expect(listener).not.toHaveBeenCalled();
  });
});
