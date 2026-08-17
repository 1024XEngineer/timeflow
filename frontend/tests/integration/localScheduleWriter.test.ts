import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalScheduleWriter } from '../../src/features/assistant/data/local/LocalScheduleWriter';
import type { AppliedCommand } from '../../src/features/assistant/domain/ConversationTurn';
import { ScheduleLocalRepository } from '../../src/features/schedule/data';
import { SqliteLocalScheduleReader } from '../../src/features/reminder/data/local/SqliteLocalScheduleReader';
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
