import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { migrateScheduleDatabase } from './migrations';

export const TIMEFLOW_DATABASE_NAME = 'timeflow.db';

export async function openTimeflowDatabase(): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(TIMEFLOW_DATABASE_NAME);
  // WAL 依赖原生共享内存；Web 的 wa-sqlite/OPFS 不支持，设了会让预览打不开库。
  if (process.env.EXPO_OS !== 'web') {
    await database.execAsync('PRAGMA journal_mode = WAL');
  }
  await migrateScheduleDatabase(database);
  return database;
}
