import { describe, expect, it, jest } from '@jest/globals';

import {
  ACCOUNT_STATE_CLEANUP_TIMEOUT_MS,
  AuthInvalidationCoordinator,
} from '../../../../../src/features/auth/application/AuthInvalidationCoordinator';
import type { AuthDiagnosticEvent } from '../../../../../src/features/auth/application/AuthDiagnostics';

describe('AuthInvalidationCoordinator', () => {
  it('shares one in-flight invalidation cleanup', async () => {
    const deferred = createDeferred<void>();
    const controller = {
      getState: () => ({
        session: {
          accountId: 'acc_001',
          accessToken: 'opaque-token',
          expiresAt: 200_000,
          username: 'timeflow_user',
        },
        status: 'authenticated' as const,
      }),
      getAccessToken: () => 'opaque-token',
      invalidate: () => deferred.promise,
    };
    const coordinator = new AuthInvalidationCoordinator({ controller, now: () => 100_000 });

    const first = coordinator.invalidate('revoked');
    const second = coordinator.invalidate('revoked');

    expect(first).toBe(second);
    expect(coordinator.isInvalidating()).toBe(true);
    deferred.resolve();
    await first;
    expect(coordinator.isInvalidating()).toBe(false);
  });

  it('invalidates an obviously expired session before withholding its token', async () => {
    let invalidated = false;
    const controller = {
      getState: () => ({
        session: {
          accountId: 'acc_001',
          accessToken: 'opaque-token',
          expiresAt: 130_000,
          username: 'timeflow_user',
        },
        status: 'authenticated' as const,
      }),
      getAccessToken: () => 'opaque-token',
      invalidate: async () => {
        invalidated = true;
      },
    };
    const coordinator = new AuthInvalidationCoordinator({ controller, now: () => 100_000 });

    await expect(coordinator.getAccessToken()).resolves.toBeUndefined();
    expect(invalidated).toBe(true);
  });

  it('runs socket, account and controller cleanup in one fixed order', async () => {
    const order: string[] = [];
    const coordinator = new AuthInvalidationCoordinator({
      accountStateCleaners: {
        clearAll: async () => {
          order.push('account');
        },
      },
      controller: {
        getAccessToken: () => 'opaque-token',
        getState: () => ({
          session: {
            accountId: 'acc_001',
            accessToken: 'opaque-token',
            expiresAt: 200_000,
            username: 'timeflow_user',
          },
          status: 'authenticated' as const,
        }),
        invalidate: async () => {
          order.push('controller');
        },
      },
      now: () => 100_000,
      socket: {
        close: () => {
          order.push('socket');
        },
      },
    });

    await coordinator.invalidate('revoked');

    expect(order).toEqual(['socket', 'controller', 'account']);
  });

  it('clears the session even when account cleanup never settles', async () => {
    jest.useFakeTimers();
    try {
      let sessionCleared = false;
      const coordinator = new AuthInvalidationCoordinator({
        accountStateCleaners: {
          clearAll: () => new Promise(() => undefined),
        },
        controller: {
          getAccessToken: () => 'opaque-token',
          getState: () => ({
            session: {
              accountId: 'acc_001',
              accessToken: 'opaque-token',
              expiresAt: 200_000,
              username: 'timeflow_user',
            },
            status: 'authenticated' as const,
          }),
          invalidate: async () => {
            sessionCleared = true;
          },
        },
        now: () => 100_000,
        socket: { close: () => undefined },
      });

      const done = coordinator.invalidate('revoked');
      await flushMicrotasks();
      expect(sessionCleared).toBe(true);
      expect(coordinator.isInvalidating()).toBe(true);

      jest.advanceTimersByTime(ACCOUNT_STATE_CLEANUP_TIMEOUT_MS);
      await flushMicrotasks();
      await done;
      expect(coordinator.isInvalidating()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records fixed diagnostics and continues when cleanup stages fail', async () => {
    const events: AuthDiagnosticEvent[] = [];
    const order: string[] = [];
    const coordinator = new AuthInvalidationCoordinator({
      accountStateCleaners: {
        clearAll: async () => {
          order.push('account');
          throw new Error('sensitive account cleanup failure');
        },
      },
      controller: {
        getAccessToken: () => 'opaque-token',
        getState: () => ({ status: 'unauthenticated' as const }),
        invalidate: async () => {
          order.push('controller');
          throw new Error('sensitive store failure');
        },
      },
      diagnostics: { record: (event) => events.push(event) },
      now: () => 100_000,
      socket: {
        close: () => {
          order.push('socket');
          throw new Error('sensitive frame failure');
        },
      },
    });

    await expect(coordinator.invalidate('revoked')).resolves.toBeUndefined();

    expect(order).toEqual(['socket', 'controller', 'account']);
    expect(events).toEqual([
      { component: 'websocket', event: 'auth.cleanup.failed' },
      { component: 'session-store', event: 'auth.cleanup.failed' },
      { component: 'account-state', event: 'auth.cleanup.failed' },
    ]);
    expect(events.every((event) => Object.keys(event).length === 2)).toBe(true);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
