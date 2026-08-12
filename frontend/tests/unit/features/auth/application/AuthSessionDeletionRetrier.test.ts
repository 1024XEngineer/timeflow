import { describe, expect, it } from '@jest/globals';

import { AuthSessionDeletionRetrier } from '../../../../../src/features/auth/application/AuthSessionDeletionRetrier';
import { AuthController } from '../../../../../src/features/auth/application/AuthController';
import { FakeAuthSessionStore } from '../../../../../src/features/auth/testing/FakeAuthSessionStore';

describe('AuthSessionDeletionRetrier', () => {
  it('waits for an in-flight old clear before allowing cancellation to finish', async () => {
    const store = new FakeAuthSessionStore();
    const deferred = createDeferred<void>();
    store.beforeClear = () => deferred.promise;
    const retrier = new AuthSessionDeletionRetrier(store);

    const clearing = retrier.clearOrRetry();
    await Promise.resolve();
    let cancelled = false;
    const cancellation = retrier.cancel().then(() => {
      cancelled = true;
    });

    await Promise.resolve();
    expect(cancelled).toBe(false);

    deferred.resolve();
    await Promise.all([clearing, cancellation]);
    expect(cancelled).toBe(true);
  });

  it('blocks a new session write until every overlapping old clear has finished', async () => {
    const store = new FakeAuthSessionStore();
    store.session = { accountId: 'old', accessToken: 'old-token', expiresAt: 200_000 };
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    let clearCount = 0;
    let writeStarted = false;
    store.beforeClear = () => (++clearCount === 1 ? first.promise : second.promise);
    const write = store.write.bind(store);
    store.write = async (session) => {
      writeStarted = true;
      await write(session);
    };
    const controller = new AuthController({
      authAccess: async () => ({ access_token: 'new-token', account_id: 'new', expires_in: 3600 }),
      now: () => 100_000,
      store,
    });

    const firstClear = controller.signOut();
    await Promise.resolve();
    const secondClear = controller.invalidate('expired');
    await Promise.resolve();
    second.resolve();
    await secondClear;
    const authenticating = controller.authenticate({ password: 'password123', username: 'timeflow_user' });

    await flushMicrotasks();
    expect(writeStarted).toBe(false);

    first.resolve();
    await Promise.all([firstClear, authenticating]);
    expect(store.session).toMatchObject({ accountId: 'new', accessToken: 'new-token' });
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
