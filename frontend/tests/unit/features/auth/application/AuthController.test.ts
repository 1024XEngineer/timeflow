import { describe, expect, it, jest } from '@jest/globals';

import { AuthController } from '../../../../../src/features/auth/application/AuthController';
import { AuthSessionCleanupRequiredError } from '../../../../../src/features/auth/application/interfaces';
import { FakeAuthSessionStore } from '../../../../fakes/FakeAuthSessionStore';

const credentials = { password: 'password123', username: 'timeflow_user' };
const response = { access_token: 'opaque-token', account_id: 'acc_001', expires_in: 3600 };

describe('AuthController', () => {
  it.each([
    [
      'restores a valid record',
      {
        accountId: 'acc_001',
        accessToken: 'token',
        expiresAt: 200_000,
        username: 'timeflow_user',
      },
      undefined,
      'authenticated',
    ],
    ['becomes unauthenticated without a record', undefined, undefined, 'unauthenticated'],
    [
      'keeps loading with a retry error after a normal read failure',
      undefined,
      new Error('storage unavailable'),
      'loading',
    ],
    [
      'cleans up a required record failure',
      undefined,
      new AuthSessionCleanupRequiredError(),
      'unauthenticated',
    ],
    [
      'cleans up an obviously expired record',
      {
        accountId: 'acc_001',
        accessToken: 'token',
        expiresAt: 130_000,
        username: 'timeflow_user',
      },
      undefined,
      'unauthenticated',
    ],
  ])('%s', async (_name, session, readError, status) => {
    const store = new FakeAuthSessionStore();
    let cleared = false;
    const clear = store.clear.bind(store);
    store.clear = async () => {
      cleared = true;
      await clear();
    };
    store.session = session;
    store.readError = readError;
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store,
    });

    await controller.initialize();

    expect(controller.getState().status).toBe(status);
    if (session && session.expiresAt <= 130_000) {
      expect(cleared).toBe(true);
    }
    if (status === 'loading') {
      expect(controller.getViewState()).toEqual({
        initializationError: '无法恢复登录状态，请重试',
        status: 'loading',
      });
    }
  });

  it('publishes authentication only after persisting the session', async () => {
    const store = new FakeAuthSessionStore();
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store,
    });

    await controller.authenticate(credentials);

    expect(store.session).toMatchObject({ accountId: 'acc_001', username: 'timeflow_user' });
    expect(controller.getState().status).toBe('authenticated');
    expect(controller.getAccessToken()).toBe('opaque-token');
  });

  it('cleans up and throws a redacted persistence error without authenticating when writing fails', async () => {
    const store = new FakeAuthSessionStore();
    const write = store.write.bind(store);
    let clearScheduled = false;
    store.write = async (session) => {
      await write(session);
      throw new Error('secret disk reason');
    };
    const clear = store.clear.bind(store);
    store.clear = async () => {
      clearScheduled = true;
      await clear();
    };
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store,
    });

    await expect(controller.authenticate(credentials)).rejects.toMatchObject({
      message: 'Authentication session could not be saved',
      name: 'AuthSessionPersistenceError',
    });
    expect(controller.getState().status).not.toBe('authenticated');
    expect(clearScheduled).toBe(true);
    expect(store.session).toBeUndefined();
  });

  it('blocks a new session write until an old deferred clear has finished', async () => {
    const store = new FakeAuthSessionStore();
    store.session = {
      accountId: 'old',
      accessToken: 'old-token',
      expiresAt: 200_000,
      username: 'old_user',
    };
    const deferred = createDeferred<void>();
    store.beforeClear = () => deferred.promise;
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store,
    });
    await controller.initialize();

    const signingOut = controller.invalidate('revoked');
    await Promise.resolve();
    const authenticating = controller.authenticate(credentials);
    await Promise.resolve();
    expect(controller.getAccessToken()).toBe('old-token');

    deferred.resolve();
    await Promise.all([signingOut, authenticating]);
    expect(controller.getAccessToken()).toBe('opaque-token');
  });

  it('publishes unauthenticated even when a store implementation throws synchronously', async () => {
    jest.useFakeTimers();
    const store = new FakeAuthSessionStore();
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store,
    });
    await controller.authenticate(credentials);
    const clear = store.clear.bind(store);
    store.clear = () => {
      throw new Error('raw synchronous storage failure');
    };

    await expect(controller.invalidate('revoked')).resolves.toBeUndefined();

    expect(controller.getState()).toEqual({ status: 'unauthenticated' });
    store.clear = clear;
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    jest.useRealTimers();
  });

  it('returns the same token-free view state object until state changes', () => {
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store: new FakeAuthSessionStore(),
    });

    expect(controller.getViewState()).toBe(controller.getViewState());
    expect(controller.getViewState()).not.toHaveProperty('accessToken');
  });

  it('enters a local preview session without calling the access API', async () => {
    const store = new FakeAuthSessionStore();
    let accessed = false;
    const controller = new AuthController({
      allowLocalPreview: true,
      authAccess: async () => {
        accessed = true;
        return response;
      },
      now: () => 100_000,
      store,
    });

    await controller.enterLocalPreview();

    expect(accessed).toBe(false);
    expect(controller.getViewState()).toEqual({
      accountId: 'preview_local',
      status: 'authenticated',
      username: '本地预览',
    });
    expect(store.session).toMatchObject({ accountId: 'preview_local', username: '本地预览' });
  });

  it('refuses local preview when the composition root has not enabled it', async () => {
    const controller = new AuthController({
      authAccess: async () => response,
      now: () => 100_000,
      store: new FakeAuthSessionStore(),
    });

    await expect(controller.enterLocalPreview()).rejects.toMatchObject({
      name: 'LocalPreviewAuthDisabledError',
    });
    expect(controller.getState().status).toBe('loading');
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
