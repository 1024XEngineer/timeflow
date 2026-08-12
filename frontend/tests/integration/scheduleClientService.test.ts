import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SqliteScheduleClientService } from '../../src/features/schedule/application';
import {
  ScheduleLocalRepository,
  type CloudScheduleRow,
  type LocalScheduleOccurrenceOverrideRow,
} from '../../src/features/schedule/data';
import { migrateScheduleDatabase } from '../../src/infrastructure/database/migrations';
import { SqlJsExpoDatabase } from '../helpers/sqliteTestDatabase';

function cloudSchedule(overrides: Partial<CloudScheduleRow> = {}): CloudScheduleRow {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'once',
    title: 'Schedule',
    is_all_day: 0,
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
    cloud_revision: 1,
    updated_at: '2026-08-11T07:00:00Z',
    ...overrides,
  };
}

describe('SqliteScheduleClientService', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;
  let repository: ScheduleLocalRepository;
  let service: SqliteScheduleClientService;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await migrateScheduleDatabase(database.asSQLiteDatabase());
    repository = new ScheduleLocalRepository(database.asSQLiteDatabase());
    service = new SqliteScheduleClientService(repository);
  });

  afterEach(() => {
    database.close();
  });

  it('returns active one-time and multi-day all-day schedules for the selected local date', async () => {
    await repository.applyCloudSchedule(cloudSchedule({ id: 'inside', title: 'Timed inside' }));
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'outside',
        title: 'Timed outside',
        start_time: '2026-08-18T02:00:00Z',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'all-day',
        title: 'Multi-day event',
        is_all_day: 1,
        start_time: '2026-08-16T16:00:00Z',
        end_time: '2026-08-19T16:00:00Z',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({ id: 'deleted', status: 'deleted', title: 'Deleted' }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({ id: 'other-account', account_id: 'account-b', title: 'Other account' }),
    );

    const result = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-17',
      timezone: 'Asia/Shanghai',
    });

    expect(result.map((occurrence) => occurrence.scheduleId)).toEqual(['all-day', 'inside']);
    expect(result[0]).toMatchObject({
      isAllDay: true,
      occurrenceStart: '2026-08-16T16:00:00.000Z',
      occurrenceEnd: '2026-08-19T16:00:00.000Z',
    });
  });

  it('expands only the selected recurring day and applies cancel and replace overrides', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'series',
        title: 'Weekly series',
        schedule_kind: 'recurring',
        start_time: '2026-08-03T02:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'replacement',
        title: 'Moved occurrence',
        start_time: '2026-08-17T06:00:00Z',
      }),
    );
    const replace: LocalScheduleOccurrenceOverrideRow = {
      id: 'replace-august-17',
      schedule_id: 'series',
      occurrence_start: '2026-08-17T02:00:00Z',
      action: 'replace',
      replacement_schedule_id: 'replacement',
    };
    await repository.upsertOccurrenceOverride('account-a', replace);

    const replaced = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-17',
      timezone: 'Asia/Shanghai',
    });
    const nextWeek = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-24',
      timezone: 'Asia/Shanghai',
    });

    expect(replaced.map((occurrence) => occurrence.scheduleId)).toEqual(['replacement']);
    expect(nextWeek.map((occurrence) => occurrence.scheduleId)).toEqual(['series']);
    expect(nextWeek[0].occurrenceStart).toBe('2026-08-24T02:00:00.000Z');

    await repository.upsertOccurrenceOverride('account-a', {
      id: 'cancel-august-24',
      schedule_id: 'series',
      occurrence_start: '2026-08-24T02:00:00Z',
      action: 'cancel',
      replacement_schedule_id: null,
    });
    expect(
      await service.getSchedulesByDay({
        accountId: 'account-a',
        selectedDate: '2026-08-24',
        timezone: 'Asia/Shanghai',
      }),
    ).toEqual([]);
  });

  it('keeps the recurring local wall time across New York DST', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'new-york-series',
        title: 'New York weekly',
        schedule_kind: 'recurring',
        timezone: 'America/New_York',
        start_time: '2026-01-05T14:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    );

    const result = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-09',
      timezone: 'America/New_York',
    });

    expect(result).toHaveLength(1);
    expect(result[0].occurrenceStart).toBe('2026-03-09T13:00:00.000Z');
  });

  it('returns a multi-day recurring all-day occurrence on every overlapping day', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'recurring-all-day',
        title: 'Two-day recurring event',
        schedule_kind: 'recurring',
        is_all_day: 1,
        start_time: '2026-08-16T16:00:00Z',
        end_time: '2026-08-18T16:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    );

    const secondDay = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-18',
      timezone: 'Asia/Shanghai',
    });

    expect(secondDay).toEqual([
      expect.objectContaining({
        scheduleId: 'recurring-all-day',
        isAllDay: true,
        occurrenceStart: '2026-08-16T16:00:00.000Z',
        occurrenceEnd: '2026-08-18T16:00:00.000Z',
      }),
    ]);
  });

  it('rejects malformed dates and invalid IANA timezone keys', async () => {
    await expect(
      service.getSchedulesByDay({
        accountId: 'account-a',
        selectedDate: '2026-02-30',
        timezone: 'Asia/Shanghai',
      }),
    ).rejects.toThrow('Invalid local calendar query');
    await expect(
      service.getSchedulesByDay({
        accountId: 'account-a',
        selectedDate: '2026-08-17',
        timezone: '../Asia/Shanghai',
      }),
    ).rejects.toThrow('Invalid local calendar query');
  });
});
