import type { AuthAccess } from '../contracts/auth';
import {
  AccountStateCleanerRegistry,
  AuthController,
  AuthInvalidationCoordinator,
  AuthSessionDeletionRetrier,
  NOOP_AUTH_DIAGNOSTICS,
  type AuthDiagnostics,
  type AuthSessionStore,
} from '../features/auth/application';
import { createAuthAccess, createAuthSessionStore } from '../features/auth/data';
import {
  createProtectedApiClient,
  createPublicApiClient,
  type ApiRequest,
  type CreateApiClientOptions,
} from '../infrastructure/network/client';
import {
  AuthenticatedWebSocketClient,
  type WebSocketFactory,
  type WebSocketPort,
} from '../infrastructure/websocket';

export const AUTH_WEB_SOCKET_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'ws://10.0.2.2:8000/ws';
export const AUTH_WEB_SOCKET_DEVICE_ID = process.env.EXPO_PUBLIC_DEVICE_ID ?? '';

export interface AuthRuntime {
  readonly accountStateCleaners: AccountStateCleanerRegistry;
  readonly controller: AuthController;
  readonly invalidationCoordinator: AuthInvalidationCoordinator;
  readonly publicClient: ApiRequest;
  readonly protectedClient: ApiRequest;
  readonly webSocketClient: AuthenticatedWebSocketClient;
}

export interface CreateAuthRuntimeOptions extends Pick<CreateApiClientOptions, 'fetch'> {
  readonly accountStateCleaners?: AccountStateCleanerRegistry;
  readonly deviceId?: string;
  readonly diagnostics?: AuthDiagnostics;
  readonly now?: () => number;
  readonly socketFactory?: WebSocketFactory;
  readonly store?: AuthSessionStore;
  readonly webSocketUrl?: string;
}

/** app 只在此处组合认证控制器、失效协调器与 HTTP 入口。 */
export function createAuthRuntime(options: CreateAuthRuntimeOptions = {}): AuthRuntime {
  const now = options.now ?? Date.now;
  const store = options.store ?? createAuthSessionStore();
  const diagnostics = options.diagnostics ?? NOOP_AUTH_DIAGNOSTICS;
  const accountStateCleaners =
    options.accountStateCleaners ?? new AccountStateCleanerRegistry(diagnostics);
  const retrier = new AuthSessionDeletionRetrier(store, diagnostics);
  let authAccess!: AuthAccess;
  const controller = new AuthController({
    authAccess: (request) => authAccess(request),
    now,
    retrier,
    store,
  });
  let webSocketClient!: AuthenticatedWebSocketClient;
  const invalidationCoordinator = new AuthInvalidationCoordinator({
    accountStateCleaners,
    controller,
    diagnostics,
    now,
    socket: { close: () => webSocketClient.close() },
  });
  const clientOptions = { fetch: options.fetch, invalidationCoordinator };
  const publicClient = createPublicApiClient(clientOptions);
  const protectedClient = createProtectedApiClient(clientOptions);
  authAccess = createAuthAccess(publicClient);
  webSocketClient = new AuthenticatedWebSocketClient({
    coordinator: invalidationCoordinator,
    deviceId: options.deviceId ?? AUTH_WEB_SOCKET_DEVICE_ID,
    socketFactory: options.socketFactory ?? createNativeWebSocket,
    url: options.webSocketUrl ?? AUTH_WEB_SOCKET_URL,
  });

  return {
    accountStateCleaners,
    controller,
    invalidationCoordinator,
    protectedClient,
    publicClient,
    webSocketClient,
  };
}

function createNativeWebSocket(url: string): WebSocketPort {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  return socket as unknown as WebSocketPort;
}
