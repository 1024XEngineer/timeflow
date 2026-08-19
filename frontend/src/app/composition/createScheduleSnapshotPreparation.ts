import type { SQLiteDatabase } from 'expo-sqlite';

import { ScheduleLocalRepository } from '../../features/schedule/data';
import {
  ScheduleSnapshotBootstrapService,
  SqliteScheduleSyncService,
} from '../../features/sync/application';
import { ScheduleSnapshotHttpAccess } from '../../features/sync/data';
import type { ApiRequest } from '../../infrastructure/network/client';

export function createScheduleSnapshotPreparation(database: SQLiteDatabase, request: ApiRequest) {
  const repository = new ScheduleLocalRepository(database);
  return {
    repository,
    bootstrap: new ScheduleSnapshotBootstrapService({
      access: new ScheduleSnapshotHttpAccess(request),
      schedules: repository,
      sync: new SqliteScheduleSyncService(database),
    }),
  };
}
