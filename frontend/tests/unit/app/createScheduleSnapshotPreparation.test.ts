import { describe, expect, it, jest } from '@jest/globals';
import type { SQLiteDatabase } from 'expo-sqlite';

import { createScheduleSnapshotPreparation } from '../../../src/app/composition/createScheduleSnapshotPreparation';
import type { ApiRequest } from '../../../src/infrastructure/network/client';

describe('createScheduleSnapshotPreparation', () => {
  it('shares one repository with the local bootstrap decision', async () => {
    const database = {
      getFirstAsync: jest.fn(async () => ({ count: 1 })),
    } as unknown as SQLiteDatabase;
    const request = jest.fn() as unknown as jest.MockedFunction<ApiRequest>;

    const preparation = createScheduleSnapshotPreparation(database, request);

    expect(preparation.repository).toBeDefined();
    await expect(preparation.bootstrap.ensureLocalSnapshot('account-a')).resolves.toEqual({
      status: 'skipped_local_data',
    });
    expect(database.getFirstAsync).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM local_schedules WHERE account_id = ?',
      'account-a',
    );
    expect(request).not.toHaveBeenCalled();
  });
});
