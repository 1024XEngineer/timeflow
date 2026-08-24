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
    category: 'other',
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
    await repository.applyCloudSchedule(
      cloudSchedule({ id: 'inside', title: 'Timed inside', category: 'work' }),
    );
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
    expect(result[1]).toMatchObject({ scheduleId: 'inside', category: 'work' });
  });

  it('returns only active unconfirmed location schedules for the requested account', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'location-pending',
        schedule_type: 'location',
        title: '到公司提醒我打卡',
        start_time: null,
        location_name: '公司',
        latitude: 31.2304,
        longitude: 121.4737,
        reminder_type: 'arrive_location',
        reminder_strength: 'high',
      }),
    );
    await repository.updateReminderRuntime('account-a', 'location-pending', {
      reminder_disposition_state: 'pending',
      next_trigger_at: null,
      snoozed_until: null,
      geofence_armed: 0,
      disposition_updated_at: '2026-08-11T08:00:00Z',
      sync_status: 'synced',
    });
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'location-snoozed',
        schedule_type: 'location',
        title: 'Snoozed location',
        start_time: null,
        latitude: 31.2304,
        longitude: 121.4737,
      }),
    );
    await repository.updateReminderRuntime('account-a', 'location-snoozed', {
      reminder_disposition_state: 'snoozed',
      next_trigger_at: null,
      snoozed_until: '2026-08-11T08:10:00Z',
      geofence_armed: 0,
      disposition_updated_at: '2026-08-11T08:00:00Z',
      sync_status: 'synced',
    });
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'location-confirmed',
        schedule_type: 'location',
        title: 'Confirmed location',
        start_time: null,
        latitude: 31.2304,
        longitude: 121.4737,
        reminder_disposition_state: 'confirmed',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'deleted-location',
        schedule_type: 'location',
        title: 'Deleted location',
        start_time: null,
        latitude: 31.2304,
        longitude: 121.4737,
        status: 'deleted',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'other-account-location',
        account_id: 'account-b',
        schedule_type: 'location',
        title: 'Other account location',
        start_time: null,
        latitude: 31.2304,
        longitude: 121.4737,
      }),
    );
    await repository.applyCloudSchedule(cloudSchedule({ id: 'time-a', title: 'Time schedule' }));

    await expect(service.getLocationSchedules({ accountId: 'account-a' })).resolves.toEqual([
      {
        scheduleId: 'location-pending',
        scheduleCategory: 'location',
        category: 'other',
        title: '到公司提醒我打卡',
        timezone: 'Asia/Shanghai',
        locationName: '公司',
        reminderType: 'arrive_location',
        reminderStrength: 'high',
        latitude: 31.2304,
        longitude: 121.4737,
      },
      {
        scheduleId: 'location-snoozed',
        scheduleCategory: 'location',
        category: 'other',
        title: 'Snoozed location',
        timezone: 'Asia/Shanghai',
        locationName: null,
        reminderType: null,
        reminderStrength: null,
        latitude: 31.2304,
        longitude: 121.4737,
      },
    ]);
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

  it('normalizes a Shanghai UTC UNTIL into the recurring floating timeline', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'shanghai-until',
        schedule_kind: 'recurring',
        start_time: '2026-08-03T01:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260810T010000Z',
      }),
    );

    const lastDay = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-10',
      timezone: 'Asia/Shanghai',
    });
    const afterUntil = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-17',
      timezone: 'Asia/Shanghai',
    });

    expect(lastDay).toEqual([
      expect.objectContaining({
        scheduleId: 'shanghai-until',
        occurrenceStart: '2026-08-10T01:00:00.000Z',
      }),
    ]);
    expect(afterUntil).toEqual([]);
  });

  it('keeps New York 09:00 across DST and includes the UTC UNTIL boundary', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'new-york-until',
        schedule_kind: 'recurring',
        timezone: 'America/New_York',
        start_time: '2026-03-02T14:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260316T130000Z',
      }),
    );

    const beforeDst = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-02',
      timezone: 'America/New_York',
    });
    const afterDst = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-09',
      timezone: 'America/New_York',
    });
    const lastDay = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-16',
      timezone: 'America/New_York',
    });
    const afterUntil = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-23',
      timezone: 'America/New_York',
    });

    expect(beforeDst[0].occurrenceStart).toBe('2026-03-02T14:00:00.000Z');
    expect(afterDst[0].occurrenceStart).toBe('2026-03-09T13:00:00.000Z');
    expect(lastDay[0].occurrenceStart).toBe('2026-03-16T13:00:00.000Z');
    expect(afterUntil).toEqual([]);
  });

  it('preserves UTC recurrence behavior while normalizing UTC UNTIL', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'utc-until',
        schedule_kind: 'recurring',
        timezone: 'UTC',
        start_time: '2026-08-03T09:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260810T090000Z',
      }),
    );

    const lastDay = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-10',
      timezone: 'UTC',
    });
    const afterUntil = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-08-17',
      timezone: 'UTC',
    });

    expect(lastDay[0].occurrenceStart).toBe('2026-08-10T09:00:00.000Z');
    expect(afterUntil).toEqual([]);
  });

  it('skips a nonexistent DST-gap occurrence without hiding other schedules', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'gap-series',
        title: 'Sunday 02:30',
        schedule_kind: 'recurring',
        timezone: 'America/New_York',
        start_time: '2026-03-01T07:30:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=SU',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'ordinary-on-gap-day',
        title: 'Ordinary schedule',
        timezone: 'America/New_York',
        start_time: '2026-03-08T15:00:00Z',
      }),
    );

    const gapDay = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-08',
      timezone: 'America/New_York',
    });
    const nextWeek = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-03-15',
      timezone: 'America/New_York',
    });

    expect(gapDay.map((occurrence) => occurrence.scheduleId)).toEqual(['ordinary-on-gap-day']);
    expect(nextWeek).toEqual([
      expect.objectContaining({
        scheduleId: 'gap-series',
        occurrenceStart: '2026-03-15T06:30:00.000Z',
      }),
    ]);
  });

  it('uses the earlier instant for an ambiguous New York fall-back wall time', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'fall-back-series',
        schedule_kind: 'recurring',
        timezone: 'America/New_York',
        start_time: '2026-10-25T05:30:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=SU',
      }),
    );

    const result = await service.getSchedulesByDay({
      accountId: 'account-a',
      selectedDate: '2026-11-01',
      timezone: 'America/New_York',
    });

    expect(result[0].occurrenceStart).toBe('2026-11-01T05:30:00.000Z');
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

  it('returns one complete half-open range with once, all-day, recurring, cancel, and replace data', async () => {
    await repository.applyCloudSchedule(
      cloudSchedule({ id: 'range-once', title: 'Range once', start_time: '2026-08-12T03:00:00Z' }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'range-all-day',
        title: 'Range all day',
        is_all_day: 1,
        start_time: '2026-08-11T16:00:00Z',
        end_time: '2026-08-14T16:00:00Z',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'range-series',
        title: 'Range series',
        schedule_kind: 'recurring',
        start_time: '2026-08-03T02:00:00Z',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      }),
    );
    await repository.applyCloudSchedule(
      cloudSchedule({
        id: 'range-replacement',
        title: 'Range replacement',
        start_time: '2026-08-17T05:00:00Z',
      }),
    );
    await repository.upsertOccurrenceOverride('account-a', {
      id: 'range-cancel',
      schedule_id: 'range-series',
      occurrence_start: '2026-08-10T02:00:00Z',
      action: 'cancel',
      replacement_schedule_id: null,
    });
    await repository.upsertOccurrenceOverride('account-a', {
      id: 'range-replace',
      schedule_id: 'range-series',
      occurrence_start: '2026-08-17T02:00:00Z',
      action: 'replace',
      replacement_schedule_id: 'range-replacement',
    });

    const result = await service.getSchedulesByRange({
      accountId: 'account-a',
      startDate: '2026-08-01',
      endDate: '2026-09-01',
      timezone: 'Asia/Shanghai',
    });

    expect(result).toHaveLength(6);
    expect(result.filter((occurrence) => occurrence.scheduleId === 'range-series')).toHaveLength(3);
    expect(
      result.filter((occurrence) => occurrence.scheduleId === 'range-replacement'),
    ).toHaveLength(1);
    expect(result.filter((occurrence) => occurrence.scheduleId === 'range-all-day')).toHaveLength(
      1,
    );
    expect(result.filter((occurrence) => occurrence.scheduleId === 'range-once')).toHaveLength(1);
    expect(
      result.some((occurrence) => occurrence.occurrenceStart === '2026-08-10T02:00:00.000Z'),
    ).toBe(false);
  });
});
