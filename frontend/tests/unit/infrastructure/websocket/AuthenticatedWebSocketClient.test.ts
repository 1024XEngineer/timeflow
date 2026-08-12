import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { AuthInvalidationCoordinator } from '../../../../src/features/auth/application/AuthInvalidationCoordinator';
import { createProtectedApiClient } from '../../../../src/infrastructure/network/client';
import {
  AuthenticatedWebSocketClient,
  WebSocketConnectionError,
  WebSocketNotReadyError,
  WebSocketUnauthenticatedError,
} from '../../../../src/infrastructure/websocket';
import { FakeWebSocket } from '../../../../src/infrastructure/websocket/testing/FakeWebSocket';

describe('AuthenticatedWebSocketClient', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends session.hello as its first frame and opens only after matching ready', async () => {
    const socket = new FakeWebSocket();
    const client = createClient(socket);

    const connection = client.connect();
    await Promise.resolve();
    socket.open();

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      payload: { access_token: 'opaque-token', device_id: 'device_001' },
      request_id: 'req_001',
      type: 'session.hello',
    });
    expect(client.getState()).toBe('authenticating');
    socket.receive(JSON.stringify(ready('req_001')));

    await expect(connection).resolves.toMatchObject({ type: 'session.ready' });
    expect(client.getState()).toBe('ready');
  });

  it('reuses one connection promise and never creates a second socket', async () => {
    const socket = new FakeWebSocket();
    const socketFactory = jest.fn(() => socket);
    const client = createClient(socket, { socketFactory });

    const first = client.connect();
    const second = client.connect();
    await flushPromises();
    socket.open();
    socket.receive(JSON.stringify(ready('req_001')));

    await expect(first).resolves.toMatchObject({ type: 'session.ready' });
    expect(second).toBe(first);
    expect(client.connect()).toBe(first);
    expect(socketFactory).toHaveBeenCalledTimes(1);
  });

  it('rejects JSON and binary business frames until ready and sends them afterwards', async () => {
    const socket = new FakeWebSocket();
    const client = createClient(socket);
    const binary = new ArrayBuffer(4);

    expect(() => client.send('{"type":"voice.stream.start"}')).toThrow(WebSocketNotReadyError);
    expect(() => client.send(binary)).toThrow(WebSocketNotReadyError);
    const connection = client.connect();
    await flushPromises();
    socket.open();
    socket.receive(JSON.stringify(ready('req_001')));
    await connection;
    client.send('{"type":"voice.stream.start"}');
    client.send(binary);

    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[2]).toBe(binary);
  });

  it('delivers JSON and binary business frames after ready until unsubscribed', async () => {
    const socket = new FakeWebSocket();
    const client = createClient(socket);
    const listener = jest.fn();
    const unsubscribe = client.subscribe(listener);
    const connection = client.connect();
    await flushPromises();
    socket.open();
    socket.receive(JSON.stringify(ready('req_001')));
    await connection;
    const json = '{"type":"assistant.delta"}';
    const binary = new ArrayBuffer(4);

    socket.receive(json);
    socket.receive(binary);

    expect(listener).toHaveBeenNthCalledWith(1, json);
    expect(listener).toHaveBeenNthCalledWith(2, binary);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    socket.receive('{"type":"assistant.done"}');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects before token lookup when invalidation is already active', async () => {
    const getAccessToken = jest.fn(async () => 'opaque-token');
    const socketFactory = jest.fn(() => new FakeWebSocket());
    const client = new AuthenticatedWebSocketClient({
      coordinator: {
        getAccessToken,
        invalidate: async () => undefined,
        isInvalidating: () => true,
      },
      deviceId: 'device_001',
      socketFactory,
      url: 'ws://localhost/ws',
    });

    await expect(client.connect()).rejects.toBeInstanceOf(WebSocketUnauthenticatedError);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it.each([
    { deviceId: 'device_001', name: 'missing token', token: undefined },
    { deviceId: '   ', name: 'blank device id', token: 'opaque-token' },
  ] as const)('rejects $name without creating a socket', async ({ deviceId, token }) => {
    const socketFactory = jest.fn(() => new FakeWebSocket());
    const client = new AuthenticatedWebSocketClient({
      coordinator: {
        getAccessToken: async () => token,
        invalidate: async () => undefined,
        isInvalidating: () => false,
      },
      deviceId,
      socketFactory,
      url: 'ws://localhost/ws',
    });

    await expect(client.connect()).rejects.toBeInstanceOf(WebSocketUnauthenticatedError);
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it('does not create a socket when invalidation starts while an old token is pending', async () => {
    const socketFactory = jest.fn(() => new FakeWebSocket());
    const token = createDeferred<string | undefined>();
    let invalidating = false;
    const client = new AuthenticatedWebSocketClient({
      coordinator: {
        getAccessToken: () => token.promise,
        invalidate: async () => undefined,
        isInvalidating: () => invalidating,
      },
      deviceId: 'device_001',
      requestIdFactory: () => 'req_001',
      socketFactory,
      url: 'ws://localhost/ws',
    });

    const connection = client.connect();
    invalidating = true;
    token.resolve('old-opaque-token');

    await expect(connection).rejects.toBeInstanceOf(WebSocketUnauthenticatedError);
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it('cancels a connection closed while token lookup is pending', async () => {
    const socketFactory = jest.fn(() => new FakeWebSocket());
    const token = createDeferred<string | undefined>();
    const client = new AuthenticatedWebSocketClient({
      coordinator: {
        getAccessToken: () => token.promise,
        invalidate: async () => undefined,
        isInvalidating: () => false,
      },
      deviceId: 'device_001',
      socketFactory,
      url: 'ws://localhost/ws',
    });

    const connection = client.connect();
    const closed = expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    client.close();
    client.close();
    token.resolve('old-opaque-token');
    await flushPromises();

    expect(socketFactory).not.toHaveBeenCalled();
    await closed;
    expect(client.getState()).toBe('disconnected');
  });

  it.each([
    { code: 'MALFORMED_MESSAGE', kind: 'session error' },
    { code: undefined, kind: 'normal close' },
    { code: 1013, kind: 'capacity close' },
  ] as const)('closes idempotently for $kind without invalidating', async ({ code, kind }) => {
    const socket = new FakeWebSocket();
    const invalidate = jest.fn(async () => undefined);
    const client = createClient(socket, { invalidate });
    const connection = client.connect();
    await flushPromises();
    socket.open();

    if (kind === 'session error') {
      socket.receive(
        JSON.stringify({
          error: { code, message: 'rejected', retryable: false },
          ok: false,
          request_id: 'req_001',
          type: 'session.error',
        }),
      );
    } else {
      socket.closeFromServer(code);
    }
    client.close();

    await expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getState()).toBe('disconnected');
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['unknown response', JSON.stringify({ request_id: 'req_001', type: 'session.other' })],
    ['mismatched request id', JSON.stringify(ready('req_002'))],
    ['binary response', new ArrayBuffer(4)],
  ])('closes on %s without invalidating the session', async (_name, response) => {
    const socket = new FakeWebSocket();
    const invalidate = jest.fn(async () => undefined);
    const client = createClient(socket, { invalidate });
    const connection = client.connect();
    await flushPromises();
    socket.open();
    socket.receive(response);

    await expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    expect(invalidate).not.toHaveBeenCalled();
    expect(socket.closeCalls).toBe(1);
  });

  it('times out the handshake after the configured gate without invalidating', async () => {
    jest.useFakeTimers();
    const socket = new FakeWebSocket();
    const invalidate = jest.fn(async () => undefined);
    const client = createClient(socket, { handshakeTimeoutMs: 5_000, invalidate });
    const connection = client.connect();
    const rejected = expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    await flushPromises();
    socket.open();

    jest.advanceTimersByTime(5_000);

    await rejected;
    expect(socket.closeCalls).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('shares one invalidation between WebSocket and a concurrent protected HTTP 401', async () => {
    const cleanup = createDeferred<void>();
    const invalidate = jest.fn(() => cleanup.promise);
    const coordinator = new AuthInvalidationCoordinator({
      controller: {
        getAccessToken: () => 'opaque-token',
        getState: () => ({
          session: { accountId: 'acc_001', accessToken: 'opaque-token', expiresAt: 200_000 },
          status: 'authenticated' as const,
        }),
        invalidate,
      },
      now: () => 100_000,
    });
    const response = createDeferred<Response>();
    const fetch = jest.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => response.promise,
    );
    const protectedClient = createProtectedApiClient({
      fetch: fetch as typeof global.fetch,
      invalidationCoordinator: coordinator,
    });
    const socket = new FakeWebSocket();
    const webSocketClient = new AuthenticatedWebSocketClient({
      coordinator,
      deviceId: 'device_001',
      requestIdFactory: () => 'req_001',
      socketFactory: () => socket,
      url: 'ws://localhost/ws',
    });
    const connection = webSocketClient.connect();
    await flushPromises();
    socket.open();
    const httpRequest = protectedClient('/schedule');
    await flushPromises();

    socket.receive(JSON.stringify(sessionError('UNAUTHENTICATED')));
    response.resolve({
      json: async () => ({ error: { code: 'AUTH_INVALID_TOKEN', message: 'Expired' } }),
      ok: false,
      status: 401,
    } as Response);
    await expect(connection).rejects.toBeInstanceOf(WebSocketConnectionError);
    await flushPromises();

    expect(invalidate).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await expect(httpRequest).rejects.toMatchObject({ status: 401 });
  });
});

function createClient(
  socket: FakeWebSocket,
  options: {
    readonly handshakeTimeoutMs?: number;
    readonly invalidate?: jest.MockedFunction<(reason: 'expired' | 'revoked') => Promise<void>>;
    readonly socketFactory?: () => FakeWebSocket;
  } = {},
): AuthenticatedWebSocketClient {
  return new AuthenticatedWebSocketClient({
    coordinator: {
      getAccessToken: async () => 'opaque-token',
      invalidate: options.invalidate ?? jest.fn(async () => undefined),
      isInvalidating: () => false,
    },
    deviceId: 'device_001',
    handshakeTimeoutMs: options.handshakeTimeoutMs,
    requestIdFactory: () => 'req_001',
    socketFactory: options.socketFactory ?? (() => socket),
    url: 'ws://localhost/ws',
  });
}

function ready(requestId: string) {
  return {
    ok: true,
    payload: { server_time: '2026-08-06T03:00:00+00:00', session_id: 'ws_session_001' },
    request_id: requestId,
    type: 'session.ready',
  };
}

function sessionError(code: 'UNAUTHENTICATED' | 'MALFORMED_MESSAGE') {
  return {
    error: { code, message: 'Session rejected', retryable: false },
    ok: false,
    request_id: 'req_001',
    type: 'session.error',
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
