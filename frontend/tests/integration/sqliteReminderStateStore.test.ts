import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScheduleLocalRepository, type CloudScheduleRow } from '../../src/features/schedule/data';
import { SqliteReminderStateStore } from '../../src/features/reminder/data/local/SqliteReminderStateStore';
import { migrateScheduleDatabase } from '../../src/infrastructure/database/migrations';
import { SqlJsExpoDatabase } from '../helpers/sqliteTestDatabase';

const START_TIME = '2026-08-10T07:00:00Z'; // 2026-08-10 15:00 Asia/Shanghai (Monday)
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

function recurringSchedule(overrides: Partial<CloudScheduleRow> = {}): CloudScheduleRow {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'recurring',
    title: '周会',
    is_all_day: 0,
    start_time: START_TIME,
    end_time: null,
    timezone: 'Asia/Shanghai',
    // Asia/Shanghai 没有 DST，整周推进不用担心跨夏令时的偏差。
    recurrence_rule: 'FREQ=WEEKLY;COUNT=4',
    location_name: null,
    latitude: null,
    longitude: null,
    reminder_type: null,
    reminder_trigger_at: null,
    reminder_offset_minutes: null,
    reminder_strength: null,
    reminder_disposition_state: null,
    status: 'active',
    cloud_revision: 1,
    updated_at: '2026-08-09T00:00:00Z',
    ...overrides,
  };
}

describe('SqliteReminderStateStore', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;
  let repository: ScheduleLocalRepository;
  let store: SqliteReminderStateStore;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await migrateScheduleDatabase(database.asSQLiteDatabase());
    repository = new ScheduleLocalRepository(database.asSQLiteDatabase());
    store = new SqliteReminderStateStore();
    store.attach(repository, 'account-a');
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  it('returns null before attach()', async () => {
    const detached = new SqliteReminderStateStore();
    expect(await detached.read('schedule-a')).toBeNull();
  });

  it('passes through a once schedule unchanged, including a null next_trigger_at', async () => {
    await repository.applyCloudSchedule(
      recurringSchedule({ schedule_kind: 'once', recurrence_rule: null }),
    );

    const runtime = await store.read('schedule-a');

    expect(runtime?.next_trigger_at).toBeNull();
    expect(runtime?.reminder_disposition_state).toBeNull();
  });

  it('leaves a recurring schedule alone once it already has an occurrence cursor', async () => {
    await repository.applyCloudSchedule(recurringSchedule());
    await repository.updateReminderRuntime('account-a', 'schedule-a', {
      reminder_disposition_state: 'pending',
      next_trigger_at: '2026-08-17T07:00:00Z',
      snoozed_until: null,
      geofence_armed: 0,
      disposition_updated_at: '2026-08-17T07:00:00Z',
      sync_status: 'synced',
    });

    const runtime = await store.read('schedule-a');

    expect(runtime?.next_trigger_at).toBe('2026-08-17T07:00:00Z');
    expect(runtime?.reminder_disposition_state).toBe('pending');
  });

  it('computes the next occurrence and resets disposition when the cursor is null', async () => {
    await repository.applyCloudSchedule(recurringSchedule());
    // confirmInternal 的实际写法：确认之后把 disposition 设成 confirmed，同时把
    // occurrence 光标清空，这就是它触发"该往前挪一格了"的方式。
    await repository.updateReminderRuntime('account-a', 'schedule-a', {
      reminder_disposition_state: 'confirmed',
      next_trigger_at: null,
      snoozed_until: null,
      geofence_armed: 0,
      disposition_updated_at: '2026-08-10T07:00:00Z',
      sync_status: 'synced',
    });
    // "现在" 落在第 2 次和第 3 次发生之间：应该拿到第 3 次，不是回退到 start_time
    // 或者停在第 2 次。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(START_TIME) + ONE_WEEK_MS * 1.5));

    const runtime = await store.read('schedule-a');

    const expectedThirdOccurrence = new Date(
      Date.parse(START_TIME) + ONE_WEEK_MS * 2,
    ).toISOString();
    expect(runtime?.next_trigger_at).toBe(expectedThirdOccurrence);
    // 新 occurrence 的 disposition 必须重置，否则 canDeliver() 会因为上一次是
    // confirmed 就永远拦住这条日程，重复提醒响一次之后就再也不会响了。
    expect(runtime?.reminder_disposition_state).toBeNull();
    expect(runtime?.disposition_updated_at).toBeNull();
  });

  it('leaves the cursor null once the recurring series has run out of occurrences', async () => {
    await repository.applyCloudSchedule(recurringSchedule());
    await repository.updateReminderRuntime('account-a', 'schedule-a', {
      reminder_disposition_state: 'confirmed',
      next_trigger_at: null,
      snoozed_until: null,
      geofence_armed: 0,
      disposition_updated_at: '2026-08-31T07:00:00Z',
      sync_status: 'synced',
    });
    // COUNT=4：第 4 次之后系列结束，"现在"设在最后一次之后。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(START_TIME) + ONE_WEEK_MS * 10));

    const runtime = await store.read('schedule-a');

    expect(runtime?.next_trigger_at).toBeNull();
  });

  it('write() persists a runtime patch and setDisposition() preserves the current cursor', async () => {
    await repository.applyCloudSchedule(recurringSchedule());
    await store.write('schedule-a', {
      reminder_disposition_state: 'pending',
      next_trigger_at: '2026-08-17T07:00:00Z',
      snoozed_until: null,
      geofence_armed: false,
      disposition_updated_at: '2026-08-17T07:00:00Z',
      sync_status: 'pending',
      recorded_location: null,
    });

    await store.setDisposition('schedule-a', {
      schedule_id: 'schedule-a',
      state: 'confirmed',
      updated_at: '2026-08-17T07:05:00Z',
      snoozed_until: null,
      sync_status: 'pending',
    });

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored?.reminder_disposition_state).toBe('confirmed');
    // setDisposition 本身不该动 occurrence 光标，只有 confirmInternal 自己那次
    // 显式的 write() 才会把它清空。
    expect(stored?.next_trigger_at).toBe('2026-08-17T07:00:00Z');
  });
});
