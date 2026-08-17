import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LocalScheduleWriter } from '../../src/features/assistant/data/local/LocalScheduleWriter';
import type { AppliedCommand } from '../../src/features/assistant/domain/ConversationTurn';
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
});
