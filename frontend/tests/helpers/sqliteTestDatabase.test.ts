import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SqlJsExpoDatabase } from './sqliteTestDatabase';

describe('SqlJsExpoDatabase', () => {
  let sql: SqlJsStatic;
  let database: SqlJsExpoDatabase;

  beforeAll(async () => {
    sql = await initSqlJs();
  });

  beforeEach(async () => {
    database = new SqlJsExpoDatabase(new sql.Database());
    await database.execAsync('CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL)');
  });

  afterEach(() => {
    database.close();
  });

  it('commits withTransactionAsync writes', async () => {
    await database.withTransactionAsync(async () => {
      await database.runAsync('INSERT INTO items (id) VALUES (?)', 'item-a');
    });

    expect(await database.getFirstAsync<{ id: string }>('SELECT id FROM items')).toEqual({
      id: 'item-a',
    });
  });

  it('rolls back withTransactionAsync when the task fails', async () => {
    await expect(
      database.withTransactionAsync(async () => {
        await database.runAsync('INSERT INTO items (id) VALUES (?)', 'item-a');
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');

    expect(await database.getFirstAsync<{ id: string }>('SELECT id FROM items')).toBeNull();
  });
});
