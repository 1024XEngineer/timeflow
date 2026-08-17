import { describe, expect, it, jest } from '@jest/globals';
import type { SQLiteDatabase } from 'expo-sqlite';

import { migrateScheduleDatabase } from '../../../../src/infrastructure/database/migrations';

function createDatabase(userVersion: number, options: { readonly exclusiveError?: Error } = {}) {
  const execAsync = jest.fn(async () => undefined);
  const withTransactionAsync = jest.fn(async (task: () => Promise<void>) => {
    await task();
  });
  const withExclusiveTransactionAsync = jest.fn(
    async (task: (transaction: Pick<SQLiteDatabase, 'execAsync'>) => Promise<void>) => {
      if (options.exclusiveError) {
        throw options.exclusiveError;
      }
      await task({ execAsync });
    },
  );
  const database = {
    execAsync,
    getFirstAsync: jest.fn(async () => ({ user_version: userVersion })),
    withExclusiveTransactionAsync,
    withTransactionAsync,
  };
  return {
    database: database as unknown as SQLiteDatabase,
    execAsync,
    withExclusiveTransactionAsync,
    withTransactionAsync,
  };
}

describe('migrateScheduleDatabase', () => {
  it('falls back to a shared transaction when exclusive is unsupported', async () => {
    const { database, execAsync, withExclusiveTransactionAsync, withTransactionAsync } =
      createDatabase(0, {
        exclusiveError: new Error('withExclusiveTransactionAsync is not supported on web'),
      });

    await migrateScheduleDatabase(database);

    expect(withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
    expect(withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(execAsync).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS local_schedules'),
    );
    expect(execAsync).toHaveBeenCalledWith('PRAGMA user_version = 1');
  });

  it('keeps exclusive transactions when they are available', async () => {
    const { database, withExclusiveTransactionAsync, withTransactionAsync } = createDatabase(0);

    await migrateScheduleDatabase(database);

    expect(withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
    expect(withTransactionAsync).not.toHaveBeenCalled();
  });

  it('does not swallow unrelated exclusive-transaction failures', async () => {
    const failure = new Error('disk I/O error');
    const { database, withTransactionAsync } = createDatabase(0, { exclusiveError: failure });

    await expect(migrateScheduleDatabase(database)).rejects.toBe(failure);
    expect(withTransactionAsync).not.toHaveBeenCalled();
  });
});
