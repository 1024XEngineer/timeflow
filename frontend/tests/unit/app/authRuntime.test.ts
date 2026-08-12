import { describe, expect, it, jest } from '@jest/globals';

import { createAuthRuntime } from '../../../src/app/authRuntime';
import { FakeAuthSessionStore } from '../../../src/features/auth/testing/FakeAuthSessionStore';

describe('createAuthRuntime', () => {
  it('composes the authentication access entry with the shared public client', async () => {
    const fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ account_id: 'acc_001', access_token: 'opaque-token', expires_in: 3600 }),
    }));
    const runtime = createAuthRuntime({
      fetch: fetch as unknown as typeof global.fetch,
      now: () => 100_000,
      store: new FakeAuthSessionStore(),
    });

    await runtime.controller.authenticate({ password: 'password123', username: 'timeflow_user' });
    await runtime.publicClient('/auth/access', { auth: 'public', headers: { Authorization: 'Bearer stale' } });

    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(runtime.protectedClient).not.toBe(runtime.publicClient);
    expect(runtime.invalidationCoordinator).toBeDefined();
  });
});
