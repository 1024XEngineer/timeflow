import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createScheduleSnapshotPreparation } from '../../src/app/composition/createScheduleSnapshotPreparation';
import type { CloudScheduleSnapshot } from '../../src/contracts/schedule';
import { migrateScheduleDatabase } from '../../src/infrastructure/database/migrations';
import type { ApiRequest } from '../../src/infrastructure/network/client';
import { SqlJsExpoDatabase } from '../helpers/sqliteTestDatabase';

const SNAPSHOT: CloudScheduleSnapshot = {
  schedules: [
    {
      id: 'schedule-cloud-a',
      account_id: 'account-a',
      schedule_type: 'time',
      schedule_kind: 'once',
      category: 'work',
      title: 'Recovered from cloud',
      is_all_day: false,
      start_time: '2026-08-19T01:00:00Z',
      end_time: '2026-08-19T02:00:00Z',
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
      revision: 1,
      created_at: '2026-08-18T01:00:00Z',
      updated_at: '2026-08-18T02:00:00Z',
      deleted_at: null,
    },
  ],
  occurrence_overrides: [],
};

describe('schedule snapshot bootstrap integration', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await migrateScheduleDatabase(database.asSQLiteDatabase());
  });

  afterEach(() => {
    database.close();
  });

  it('recovers an empty local account once and skips the next HTTP request', async () => {
    const requestedPaths: string[] = [];
    const request: ApiRequest = async <T>(path: string): Promise<T> => {
      requestedPaths.push(path);
      return SNAPSHOT as T;
    };
    const preparation = createScheduleSnapshotPreparation(database.asSQLiteDatabase(), request);

    await expect(preparation.bootstrap.ensureLocalSnapshot('account-a')).resolves.toEqual({
      status: 'applied',
    });
    expect(await preparation.repository.getSchedule('account-a', 'schedule-cloud-a')).toMatchObject(
      {
        title: 'Recovered from cloud',
        cloud_revision: 1,
        sync_status: 'synced',
      },
    );

    await expect(preparation.bootstrap.ensureLocalSnapshot('account-a')).resolves.toEqual({
      status: 'skipped_local_data',
    });
    expect(requestedPaths).toEqual(['/schedule/snapshot']);
  });
});
