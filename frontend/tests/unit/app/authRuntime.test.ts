import { describe, expect, it, jest } from '@jest/globals';

import { createAuthRuntime } from '../../../src/app/authRuntime';
import { FakeAuthSessionStore } from '../../fakes/FakeAuthSessionStore';
import { FakeWebSocket } from '../../fakes/FakeWebSocket';

describe('createAuthRuntime', () => {
  it('composes the authentication access entry with the shared public client', async () => {
    const fetch = createSuccessfulAuthFetch();
    const runtime = createAuthRuntime({
      fetch: fetch as typeof global.fetch,
      now: () => 100_000,
      store: new FakeAuthSessionStore(),
    });

    await runtime.controller.authenticate({ password: 'password123', username: 'timeflow_user' });
    await runtime.publicClient('/auth/access', {
      auth: 'public',
      headers: { Authorization: 'Bearer stale' },
    });

    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(runtime.protectedClient).not.toBe(runtime.publicClient);
    expect(runtime.invalidationCoordinator).toBeDefined();
  });

  it('injects the shared coordinator, URL and device id into the WebSocket client', async () => {
    const socket = new FakeWebSocket();
    const socketFactory = jest.fn(() => socket);
    const runtime = createAuthRuntime({
      deviceId: 'device_001',
      fetch: createSuccessfulAuthFetch() as typeof global.fetch,
      socketFactory,
      store: new FakeAuthSessionStore(),
      webSocketUrl: 'ws://localhost/ws',
    });
    await runtime.controller.authenticate({ password: 'password123', username: 'timeflow_user' });

    const connection = runtime.webSocketClient.connect();
    await Promise.resolve();
    socket.open();
    socket.receive(
      JSON.stringify({
        ok: true,
        payload: { server_time: '2026-08-06T03:00:00+00:00', session_id: 'ws_session_001' },
        request_id: 'session-hello-1',
        type: 'session.ready',
      }),
    );
    await connection;

    expect(socketFactory).toHaveBeenCalledWith('ws://localhost/ws?device_id=device_001');
    runtime.webSocketClient.close();
    runtime.webSocketClient.close();
    expect(socket.closeCalls).toBe(1);
  });
});

function createSuccessfulAuthFetch() {
  return jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          account_id: 'acc_001',
          access_token: 'opaque-token',
          expires_in: 3600,
        }),
      }) as Response,
  );
}
