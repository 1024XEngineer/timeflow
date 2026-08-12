import { describe, expect, it, jest } from '@jest/globals';

import {
  AccountStateCleanerAlreadyRegisteredError,
  AccountStateCleanerRegistry,
} from '../../../../../src/features/auth/application/AccountStateCleanerRegistry';
import type { AuthDiagnosticEvent } from '../../../../../src/features/auth/application/AuthDiagnostics';

describe('AccountStateCleanerRegistry', () => {
  it('rejects duplicate fixed keys', () => {
    const registry = new AccountStateCleanerRegistry();
    registry.register('schedule-view', () => undefined);

    expect(() => registry.register('schedule-view', () => undefined)).toThrow(
      AccountStateCleanerAlreadyRegisteredError,
    );
  });

  it('cleans in registration order and continues after a cleaner fails', async () => {
    const events: AuthDiagnosticEvent[] = [];
    const order: string[] = [];
    const registry = new AccountStateCleanerRegistry({ record: (event) => events.push(event) });
    registry.register('schedule-view', async () => {
      order.push('schedule-view');
      throw new Error('account id and token must never enter diagnostics');
    });
    registry.register('reminder-runtime', () => {
      order.push('reminder-runtime');
    });

    await registry.clearAll();

    expect(order).toEqual(['schedule-view', 'reminder-runtime']);
    expect(events).toEqual([
      { component: 'schedule-view', event: 'auth.cleanup.failed' },
    ]);
    expect(events[0]).not.toHaveProperty('error');
  });

  it('awaits each asynchronous cleaner before starting the next', async () => {
    const first = createDeferred<void>();
    const second = jest.fn(async () => undefined);
    const registry = new AccountStateCleanerRegistry();
    registry.register('schedule-view', () => first.promise);
    registry.register('reminder-runtime', second);

    const clearing = registry.clearAll();
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();

    first.resolve();
    await clearing;
    expect(second).toHaveBeenCalledTimes(1);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
