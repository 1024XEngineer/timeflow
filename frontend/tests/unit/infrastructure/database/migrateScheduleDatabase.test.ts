import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';

import { migrateScheduleDatabase } from '../../../../src/infrastructure/database/migrations';

function createDatabase(userVersion: number) {
  const execAsync = jest.fn(async () => undefined);
  const withTransactionAsync = jest.fn(async (task: () => Promise<void>) => {
    await task();
  });
  const withExclusiveTransactionAsync = jest.fn(
    async (task: (transaction: Pick<SQLiteDatabase, 'execAsync'>) => Promise<void>) => {
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
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    Platform.OS = originalPlatform;
  });

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  it('uses a non-exclusive transaction on web', async () => {
    Platform.OS = 'web';
    const { database, execAsync, withExclusiveTransactionAsync, withTransactionAsync } =
      createDatabase(0);

    await migrateScheduleDatabase(database);

    expect(withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(withExclusiveTransactionAsync).not.toHaveBeenCalled();
    expect(execAsync).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS local_schedules'),
    );
    expect(execAsync).toHaveBeenCalledWith('PRAGMA user_version = 1');
  });

  it('keeps exclusive transactions off web', async () => {
    Platform.OS = 'android';
    const { database, withExclusiveTransactionAsync, withTransactionAsync } = createDatabase(0);

    await migrateScheduleDatabase(database);

    expect(withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
    expect(withTransactionAsync).not.toHaveBeenCalled();
  });
});
