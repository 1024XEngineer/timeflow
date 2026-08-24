import { describe, expect, it } from '@jest/globals';

import { withDatabaseAccess } from '../../../../src/infrastructure/database/accessGate';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('withDatabaseAccess', () => {
  it('runs queued tasks one at a time, in order', async () => {
    const order: string[] = [];
    const first = withDatabaseAccess(async () => {
      order.push('a:start');
      await Promise.resolve();
      order.push('a:end');
    });
    const second = withDatabaseAccess(async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await Promise.all([first, second]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not let an unrelated caller slip in while a task awaits mid-flight', async () => {
    // 回归测试：这个门曾经用一个模块级 inside 布尔量做"可重入"，于是门内任务
    // await 非数据库操作（等原生弹窗、等 listener 跑完）的间隙里，任何别的调用方
    // 都会看到 inside 为真而直接穿过队列——等于没排队。
    const gate = deferred();
    const order: string[] = [];

    const held = withDatabaseAccess(async () => {
      order.push('held:start');
      await gate.promise;
      order.push('held:end');
    });

    await Promise.resolve();
    const intruder = withDatabaseAccess(async () => {
      order.push('intruder');
    });

    // 队列被 held 占着，闯入者此刻绝不能已经跑过。
    await Promise.resolve();
    expect(order).toEqual(['held:start']);

    gate.resolve();
    await Promise.all([held, intruder]);
    expect(order).toEqual(['held:start', 'held:end', 'intruder']);
  });

  it('keeps draining the queue after a task rejects', async () => {
    const failing = withDatabaseAccess(async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    await expect(withDatabaseAccess(async () => 'ok')).resolves.toBe('ok');
  });
});
