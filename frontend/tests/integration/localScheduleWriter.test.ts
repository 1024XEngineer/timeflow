import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalScheduleWriter } from '../../src/features/assistant/data/local/LocalScheduleWriter';
import type { AppliedCommand } from '../../src/features/assistant/domain/ConversationTurn';
import { SqliteLocalScheduleReader } from '../../src/features/reminder/data/local/SqliteLocalScheduleReader';
import { ScheduleLocalRepository } from '../../src/features/schedule/data';
import { migrateScheduleDatabase } from '../../src/infrastructure/database/migrations';
import { SqlJsExpoDatabase } from '../helpers/sqliteTestDatabase';

function appliedCommand(overrides: Partial<AppliedCommand> = {}): AppliedCommand {
  return {
    operation: 'create_schedule',
    status: 'applied',
    schedule: {
      id: 'schedule-a',
      schedule_type: 'time',
      schedule_kind: 'once',
      title: 'Team sync',
      is_all_day: false,
      timezone: 'Asia/Shanghai',
      start_time: '2026-08-12T07:00:00Z',
      revision: 1,
    },
    ...overrides,
  };
}

describe('LocalScheduleWriter', () => {
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

  it('writes the schedule when the command carries one', async () => {
    const writer = new LocalScheduleWriter(repository);
    await writer.applyCommandResult('account-a', appliedCommand());

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored?.title).toBe('Team sync');
  });

  it('rejects a schedule payload missing a required field', async () => {
    const writer = new LocalScheduleWriter(repository);
    const command = appliedCommand({ schedule: { id: 'schedule-a' } });

    await expect(writer.applyCommandResult('account-a', command)).rejects.toThrow(
      'command.result.schedule.schedule_type must be a non-empty string',
    );
  });

  it('does not write when the command was not applied', async () => {
    const writer = new LocalScheduleWriter(repository);
    await writer.applyCommandResult('account-a', appliedCommand({ status: 'rejected' }));

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored).toBeNull();
  });

  it('writes an occurrence override even when the command carries no schedule', async () => {
    const writer = new LocalScheduleWriter(repository);
    // 先建好日程，delete_this_occurrence 只回一条 override，不带 schedule 快照。
    await writer.applyCommandResult('account-a', appliedCommand());

    await writer.applyCommandResult(
      'account-a',
      appliedCommand({
        operation: 'delete_schedule',
        schedule: undefined,
        occurrence_overrides: [
          {
            id: 'override-a',
            schedule_id: 'schedule-a',
            occurrence_start: '2026-08-19T07:00:00Z',
            action: 'cancel',
            replacement_schedule_id: null,
          },
        ],
      }),
    );

    const overrides = await repository.listOccurrenceOverrides('account-a', 'schedule-a');
    expect(overrides).toEqual([
      {
        id: 'override-a',
        schedule_id: 'schedule-a',
        occurrence_start: '2026-08-19T07:00:00Z',
        action: 'cancel',
        replacement_schedule_id: null,
      },
    ]);
  });

  it('does nothing when the command has neither a schedule nor overrides', async () => {
    const writer = new LocalScheduleWriter(repository);
    await writer.applyCommandResult(
      'account-a',
      appliedCommand({ schedule: undefined, occurrence_overrides: undefined }),
    );

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored).toBeNull();
  });

  it('writes every schedule when the command carries the plural field', async () => {
    const writer = new LocalScheduleWriter(repository);
    await writer.applyCommandResult(
      'account-a',
      appliedCommand({
        schedule: undefined,
        schedules: [
          appliedCommand().schedule!,
          { ...appliedCommand().schedule!, id: 'schedule-b', title: 'Follow-up' },
        ],
      }),
    );

    expect((await repository.getSchedule('account-a', 'schedule-a'))?.title).toBe('Team sync');
    expect((await repository.getSchedule('account-a', 'schedule-b'))?.title).toBe('Follow-up');
  });

  it('does not write a list_schedules query result even if it carries schedules', async () => {
    const writer = new LocalScheduleWriter(repository);
    await writer.applyCommandResult(
      'account-a',
      appliedCommand({
        operation: 'list_schedules',
        schedule: undefined,
        schedules: [appliedCommand().schedule!],
      }),
    );

    expect(await repository.getSchedule('account-a', 'schedule-a')).toBeNull();
  });

  it('rolls back the schedule write when a later override write fails', async () => {
    const writer = new LocalScheduleWriter(repository);
    const command = appliedCommand({
      occurrence_overrides: [
        {
          id: 'override-a',
          // upsertOccurrenceOverride 找不到这个 schedule_id 对应的本地日程，返回 false。
          schedule_id: 'schedule-does-not-exist',
          occurrence_start: '2026-08-19T07:00:00Z',
          action: 'cancel',
          replacement_schedule_id: null,
        },
      ],
    });

    await expect(writer.applyCommandResult('account-a', command)).rejects.toThrow(
      'Could not apply occurrence override override-a',
    );
    // schedule 那一半本来会写成功，但事务应该把它也回滚掉，不留半吊子状态。
    expect(await repository.getSchedule('account-a', 'schedule-a')).toBeNull();
  });
});

describe('LocalScheduleWriter refresh wiring', () => {
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

  it('refreshes the attached schedule reader after a successful write', async () => {
    const reader = new SqliteLocalScheduleReader();
    reader.attach(repository, 'account-a');
    const listener = vi.fn();
    reader.subscribe(listener);

    const writer = new LocalScheduleWriter(repository, reader);
    await writer.applyCommandResult('account-a', appliedCommand());

    expect(listener).toHaveBeenCalledTimes(1);
    expect(await reader.getReminderSchedule('schedule-a')).toMatchObject({ title: 'Team sync' });
  });

  it('does not refresh when the command was not applied', async () => {
    const reader = new SqliteLocalScheduleReader();
    reader.attach(repository, 'account-a');
    const listener = vi.fn();
    reader.subscribe(listener);

    const writer = new LocalScheduleWriter(repository, reader);
    await writer.applyCommandResult('account-a', appliedCommand({ status: 'rejected' }));

    expect(listener).not.toHaveBeenCalled();
    expect(await reader.getReminderSchedule('schedule-a')).toBeNull();
  });

  it('works without a schedule reader wired in', async () => {
    const writer = new LocalScheduleWriter(repository);
    await expect(writer.applyCommandResult('account-a', appliedCommand())).resolves.toBeUndefined();

    const stored = await repository.getSchedule('account-a', 'schedule-a');
    expect(stored?.title).toBe('Team sync');
  });
});
