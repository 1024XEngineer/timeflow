/**
 * 全应用共用同一条 SQLite 连接（见 sqlite.ts 里为什么必须只开一条），代价是
 * 这条连接上的调用方彼此可见：事务的 BEGIN/COMMIT 是连接级的，事务进行中别人
 * 插进来的写会被卷进同一个事务，两个事务重叠还会撞上 "cannot start a
 * transaction within a transaction"。所以每一次逻辑上的数据库操作都排这条队。
 *
 * 队列不可重入，也不要给它加"当前是否已在门内"这类全局标志：门内任务 await
 * 非数据库操作（等原生弹窗、等 listener 跑完）的间隙里，其它无关代码路径同样
 * 会看到那个标志为真而直接穿过队列，等于没排队。需要在已持有队列的代码里再做
 * 数据库操作，就把那段操作本身留在门外，或者用一个明确标记"已在门内"的对象
 * （见 ScheduleLocalRepository 的 insideGate 参数），不要靠全局状态推断。
 */
let tail: Promise<unknown> = Promise.resolve();

export function withDatabaseAccess<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
