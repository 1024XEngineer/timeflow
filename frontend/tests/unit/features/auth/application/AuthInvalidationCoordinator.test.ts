import { describe, expect, it } from '@jest/globals';

import { AuthInvalidationCoordinator } from '../../../../../../src/features/auth/application/AuthInvalidationCoordinator';

describe('AuthInvalidationCoordinator', () => {
  it('shares one in-flight invalidation cleanup', async () => {
    const deferred = createDeferred<void>();
    const controller = {
      getState: () => ({ session: { accountId: 'acc_001', accessToken: 'opaque-token', expiresAt: 200_000 }, status: 'authenticated' as const }),
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
      getState: () => ({ session: { accountId: 'acc_001', accessToken: 'opaque-token', expiresAt: 130_000 }, status: 'authenticated' as const }),
      getAccessToken: () => 'opaque-token',
      invalidate: async () => { invalidated = true; },
    };
    const coordinator = new AuthInvalidationCoordinator({ controller, now: () => 100_000 });

    await expect(coordinator.getAccessToken()).resolves.toBeUndefined();
    expect(invalidated).toBe(true);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
