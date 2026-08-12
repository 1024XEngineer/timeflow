import type { SQLiteDatabase } from 'expo-sqlite';
import type { BindParams, Database, SqlValue } from 'sql.js';

export class SqlJsExpoDatabase {
  public constructor(private readonly database: Database) {}

  public async execAsync(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  public async runAsync(sql: string, ...parameters: unknown[]): Promise<{ changes: number }> {
    this.database.run(sql, normalizeParameters(parameters));
    return { changes: this.database.getRowsModified() };
  }

  public async getFirstAsync<Row>(sql: string, ...parameters: unknown[]): Promise<Row | null> {
    const statement = this.database.prepare(sql, normalizeParameters(parameters));
    try {
      return statement.step() ? (statement.getAsObject() as Row) : null;
    } finally {
      statement.free();
    }
  }

  public async getAllAsync<Row>(sql: string, ...parameters: unknown[]): Promise<Row[]> {
    const statement = this.database.prepare(sql, normalizeParameters(parameters));
    const rows: Row[] = [];
    try {
      while (statement.step()) {
        rows.push(statement.getAsObject() as Row);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  public async withExclusiveTransactionAsync(
    task: (transaction: SQLiteDatabase) => Promise<void>,
  ): Promise<void> {
    this.database.run('BEGIN EXCLUSIVE');
    try {
      await task(this.asSQLiteDatabase());
      this.database.run('COMMIT');
    } catch (error) {
      this.database.run('ROLLBACK');
      throw error;
    }
  }

  public asSQLiteDatabase(): SQLiteDatabase {
    return this as unknown as SQLiteDatabase;
  }

  public close(): void {
    this.database.close();
  }
}

function normalizeParameters(parameters: unknown[]): BindParams {
  if (parameters.length === 0) {
    return null;
  }
  const value = parameters.length === 1 ? parameters[0] : parameters;
  if (Array.isArray(value)) {
    return value as SqlValue[];
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, SqlValue>;
  }
  return [value as SqlValue];
}
