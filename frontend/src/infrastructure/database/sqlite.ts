import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { migrateScheduleDatabase } from './migrations';

export const TIMEFLOW_DATABASE_NAME = 'timeflow.db';

export async function openTimeflowDatabase(): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(TIMEFLOW_DATABASE_NAME);
  await database.execAsync('PRAGMA journal_mode = WAL');
  await migrateScheduleDatabase(database);
  return database;
}
