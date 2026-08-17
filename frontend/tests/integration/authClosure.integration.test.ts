import { describe, expect, it, jest } from '@jest/globals';

import { createAuthRuntime, type AuthRuntime } from '../../src/app/authRuntime';
import type { AuthDiagnosticEvent } from '../../src/features/auth/application';
import { FakeAuthSessionStore } from '../fakes/FakeAuthSessionStore';
import { ApiError } from '../../src/infrastructure/network/client';
import { WebSocketConnectionError } from '../../src/infrastructure/websocket';
import { FakeWebSocket } from '../fakes/FakeWebSocket';
import httpAccessSuccess from '../fixtures/auth/http-access-success.json';
import httpInvalidCredentials from '../fixtures/auth/http-invalid-credentials.json';
import httpInvalidToken from '../fixtures/auth/http-invalid-token.json';
import wsSessionMalformed from '../fixtures/auth/ws-session-malformed.json';
import wsSessionReady from '../fixtures/auth/ws-session-ready.json';
import wsSessionUnauthenticated from '../fixtures/auth/ws-session-unauthenticated.json';
import { FakeAuthHttpTransport } from '../fakes/FakeAuthHttpTransport';

const credentials = { password: 'password123', username: 'timeflow_user' };

describe('authentication closure', () => {
  it('uses one public access entry for new and existing accounts', async () => {
    const harness = createHarness();
    harness.transport.enqueueJson(200, httpAccessSuccess);
    harness.transport.enqueueJson(200, {
      ...httpAccessSuccess,
      account_id: 'acc_002',
      access_token: 'second-opaque-token',
    });

    await harness.runtime.controller.authenticate(credentials);
    await harness.runtime.controller.authenticate({ ...credentials, username: 'existing_user' });

    expect(harness.transport.requests).toHaveLength(2);
    expect(
      harness.transport.requests.every((request) => request.url.endsWith('/auth/access')),
    ).toBe(true);
    expect(
      harness.transport.requests.every((request) => !request.headers.has('Authorization')),
    ).toBe(true);
    expect(harness.runtime.controller.getViewState()).toEqual({
      accountId: 'acc_002',
      status: 'authenticated',
      username: 'existing_user',
    });
  });

  it('keeps store and root authentication state unchanged for invalid credentials', async () => {
    const harness = createHarness();
    await harness.runtime.controller.initialize();
    harness.transport.enqueueJson(401, httpInvalidCredentials);

    await expect(harness.runtime.controller.authenticate(credentials)).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
      reason: 'business',
    });

    expect(harness.store.session).toBeUndefined();
    expect(harness.runtime.controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });

  it('uses the same opaque token for protected HTTP and the WebSocket hello', async () => {
    const harness = createHarness();
    await authenticate(harness);
    harness.transport.enqueueJson(200, { schedules: [] });

    await harness.runtime.protectedClient('/schedules', {
      headers: { Authorization: 'Bearer stale', 'X-Trace-Id': 'trace_001' },
    });
    const { connection, hello, socket } = await openSocket(harness);
    socket.receive(JSON.stringify({ ...wsSessionReady, request_id: hello.request_id }));
    await connection;

    const protectedRequest = harness.transport.requests[1];
    expect(protectedRequest?.headers.get('Authorization')).toBe('Bearer opaque-token');
    expect(protectedRequest?.headers.get('X-Trace-Id')).toBe('trace_001');
    expect(hello.payload.access_token).toBe('opaque-token');
    expect(hello.payload.device_id).toBe('device_001');
    expect(harness.socketFactory).toHaveBeenCalledWith('ws://localhost/ws?device_id=device_001');
  });

  it('deduplicates concurrent HTTP 401 and WebSocket unauthenticated cleanup', async () => {
    const harness = createHarness();
    await authenticate(harness);
    const { connection, hello, socket } = await openSocket(harness);
    const connectionFailure = expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    const clearGate = createDeferred<void>();
    const clear = harness.store.clear.bind(harness.store);
    let clearCalls = 0;
    harness.store.beforeClear = () => clearGate.promise;
    harness.store.clear = async () => {
      clearCalls += 1;
      await clear();
    };
    const deferredHttp = harness.transport.enqueueDeferredJson();
    const httpRequest = harness.runtime.protectedClient('/schedules');
    await flushMicrotasks();

    socket.receive(JSON.stringify({ ...wsSessionUnauthenticated, request_id: hello.request_id }));
    deferredHttp.resolve(401, httpInvalidToken);
    await flushMicrotasks();

    expect(clearCalls).toBe(1);
    clearGate.resolve();
    await connectionFailure;
    await expect(httpRequest).rejects.toBeInstanceOf(ApiError);
    expect(harness.runtime.controller.getState()).toEqual({ status: 'unauthenticated' });
  });

  it('keeps a local preview session when voice handshake and protected HTTP are unauthenticated', async () => {
    const harness = createHarness({ allowLocalPreview: true });
    await harness.runtime.controller.enterLocalPreview();
    const { connection, hello, socket } = await openSocket(harness);
    harness.transport.enqueueJson(401, httpInvalidToken);

    socket.receive(JSON.stringify({ ...wsSessionUnauthenticated, request_id: hello.request_id }));

    await expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    await expect(harness.runtime.protectedClient('/schedules')).rejects.toBeInstanceOf(ApiError);
    expect(harness.runtime.controller.getViewState()).toEqual({
      accountId: 'preview_local',
      status: 'authenticated',
      username: '本地预览',
    });
    expect(harness.store.session?.accountId).toBe('preview_local');
  });

  it('retains the session for non-401 errors and ordinary WebSocket failures', async () => {
    const harness = createHarness();
    await authenticate(harness);
    harness.transport.enqueueJson(500, httpInvalidToken);

    await expect(harness.runtime.protectedClient('/schedules')).rejects.toMatchObject({
      status: 500,
    });
    harness.transport.enqueueNetworkError();
    await expect(harness.runtime.protectedClient('/schedules')).rejects.toBeInstanceOf(TypeError);

    const capacityConnection = await openSocket(harness);
    const capacityFailure = expect(capacityConnection.connection).rejects.toBeInstanceOf(
      WebSocketConnectionError,
    );
    capacityConnection.socket.closeFromServer(1013);
    await capacityFailure;
    const malformedConnection = await openSocket(harness);
    const malformedFailure = expect(malformedConnection.connection).rejects.toBeInstanceOf(
      WebSocketConnectionError,
    );
    malformedConnection.socket.receive(
      JSON.stringify({
        ...wsSessionMalformed,
        request_id: malformedConnection.hello.request_id,
      }),
    );
    await malformedFailure;

    expect(harness.runtime.controller.getState().status).toBe('authenticated');
    expect(harness.store.session?.accessToken).toBe('opaque-token');
  });

  it('returns to unauthenticated before a failed store clear retry succeeds', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      await authenticate(harness);
      harness.store.clearError = new Error('raw storage failure');

      await harness.runtime.invalidationCoordinator.invalidate('revoked');

      expect(harness.runtime.controller.getState()).toEqual({ status: 'unauthenticated' });
      expect(harness.store.session?.accessToken).toBe('opaque-token');
      expect(harness.events).toEqual([
        { component: 'session-store', event: 'auth.cleanup.failed' },
      ]);
      harness.store.clearError = undefined;
      jest.advanceTimersByTime(1_000);
      await flushMicrotasks();
      expect(harness.store.session).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for an old clear before storing a new session', async () => {
    const harness = createHarness();
    await authenticate(harness);
    const clearGate = createDeferred<void>();
    harness.store.beforeClear = () => clearGate.promise;
    const signingOut = harness.runtime.invalidationCoordinator.invalidate('revoked');
    await flushMicrotasks();
    harness.transport.enqueueJson(200, {
      ...httpAccessSuccess,
      account_id: 'acc_002',
      access_token: 'new-opaque-token',
    });
    const authenticating = harness.runtime.controller.authenticate({
      ...credentials,
      username: 'second_user',
    });
    await flushMicrotasks();

    expect(harness.store.session?.accessToken).toBe('opaque-token');
    clearGate.resolve();
    await Promise.all([signingOut, authenticating]);

    expect(harness.store.session?.accessToken).toBe('new-opaque-token');
    expect(harness.runtime.controller.getViewState()).toEqual({
      accountId: 'acc_002',
      status: 'authenticated',
      username: 'second_user',
    });
  });

  it('actively signs out by closing the socket, clearing account memory and deleting session state', async () => {
    const harness = createHarness();
    await authenticate(harness);
    const cleanupOrder: string[] = [];
    harness.runtime.accountStateCleaners.register('schedule-view', () => {
      cleanupOrder.push(`schedule:${harness.sockets[0]?.closeCalls}`);
    });
    harness.runtime.accountStateCleaners.register('reminder-runtime', () => {
      cleanupOrder.push('reminder');
    });
    const { connection, hello, socket } = await openSocket(harness);
    socket.receive(JSON.stringify({ ...wsSessionReady, request_id: hello.request_id }));
    await connection;

    await harness.runtime.invalidationCoordinator.invalidate('revoked');

    expect(socket.closeCalls).toBe(1);
    expect(cleanupOrder).toEqual(['schedule:1', 'reminder']);
    expect(harness.store.session).toBeUndefined();
    expect(harness.runtime.controller.getViewState()).toEqual({ status: 'unauthenticated' });
  });
});

interface AuthHarness {
  readonly events: AuthDiagnosticEvent[];
  readonly runtime: AuthRuntime;
  readonly socketFactory: jest.MockedFunction<(url: string) => FakeWebSocket>;
  readonly sockets: FakeWebSocket[];
  readonly store: FakeAuthSessionStore;
  readonly transport: FakeAuthHttpTransport;
}

function createHarness(options: { readonly allowLocalPreview?: boolean } = {}): AuthHarness {
  const events: AuthDiagnosticEvent[] = [];
  const sockets: FakeWebSocket[] = [];
  const socketFactory = jest.fn((_: string) => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket;
  });
  const store = new FakeAuthSessionStore();
  const transport = new FakeAuthHttpTransport();
  const runtime = createAuthRuntime({
    allowLocalPreview: options.allowLocalPreview,
    deviceId: 'device_001',
    diagnostics: { record: (event) => events.push(event) },
    fetch: transport.fetch,
    now: () => 100_000,
    socketFactory,
    store,
    webSocketUrl: 'ws://localhost/ws',
  });
  return { events, runtime, socketFactory, sockets, store, transport };
}

async function authenticate(harness: AuthHarness): Promise<void> {
  harness.transport.enqueueJson(200, httpAccessSuccess);
  await harness.runtime.controller.authenticate(credentials);
}

async function openSocket(harness: AuthHarness) {
  const connection = harness.runtime.webSocketClient.connect();
  await flushMicrotasks();
  const socket = harness.sockets[harness.sockets.length - 1];
  if (!socket) {
    throw new Error('Expected FakeWebSocket to be created');
  }
  socket.open();
  const hello = JSON.parse(socket.sent[0] as string) as {
    payload: { access_token: string; device_id: string };
    request_id: string;
  };
  return { connection, hello, socket };
}

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
