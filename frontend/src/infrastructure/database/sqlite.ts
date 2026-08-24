import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { migrateScheduleDatabase } from './migrations';

export const TIMEFLOW_DATABASE_NAME = 'timeflow.db';

/**
 * 整个 JS runtime 只允许对 timeflow.db 调一次 openDatabaseAsync，所有人共用这一条。
 *
 * 这不是为了省资源，是绕开 expo-sqlite 的一个真实缺陷：原生侧 SQLiteModule 按
 * (databasePath, openOptions) 做连接缓存，第二次 open 同一个库会把**同一个** Kotlin
 * NativeDatabase 实例返回给 JS；而 expo-modules-core 的 SharedObjectRegistry 假设
 * "一个原生对象对应一个 JS 代理"，第二次注册会给同一个原生对象再分配一个 id、并
 * 覆写它自己的 sharedObjectId。等第二个 JS 代理被 GC 掉时，registry.delete() 会对
 * 这个**仍在被第一个连接使用的**原生对象调用 sharedObjectDidRelease()，进而
 * NativeDatabase.ref.close() → HybridData.resetNative()，底层 JNI 指针被就地释放。
 *
 * 之后第一条连接上任何操作都会踩空：isClosed 仍是 false、引用计数仍是 1，所以
 * maybeThrowForClosedDatabase 放行，直接走到 ref.sqlite3_prepare_v2() 上抛出无消息的
 * java.lang.NullPointerException——真机上看到的
 * "Call to function 'NativeDatabase.prepareAsync' has been rejected → java.lang.NullPointerException"
 * 就是这条链路。注意它跟并发无关，取决于 GC 时机，而且一旦发生连接就永久废掉，
 * 后续每一次读写都失败（新建日程存不进去、列表里也不出现）。
 *
 * 所以：不要在别处再 openDatabaseAsync 这个库，需要连接就调 openTimeflowDatabase()；
 * 也不要 closeAsync() 这条共享连接——关掉之后 isClosed 为 true，其他持有方全部失效。
 */
let sharedDatabase: Promise<SQLiteDatabase> | null = null;

export function openTimeflowDatabase(): Promise<SQLiteDatabase> {
  sharedDatabase ??= (async () => {
    try {
      const database = await openDatabaseAsync(TIMEFLOW_DATABASE_NAME);
      await database.execAsync('PRAGMA journal_mode = WAL');
      await migrateScheduleDatabase(database);
      return database;
    } catch (error) {
      // 打开失败不留下一个永远 reject 的缓存，下次调用可以重试。
      sharedDatabase = null;
      throw error;
    }
  })();
  return sharedDatabase;
}
