import {
  createSessionHello,
  parseSessionServerMessage,
  type SessionReady,
} from '../../contracts/authWebSocket';
import type { AuthInvalidationPort } from '../network/client';
import type { WebSocketFactory, WebSocketPort } from './WebSocketPort';

export type AuthenticatedWebSocketState =
  'disconnected' | 'connecting' | 'authenticating' | 'ready';

const HANDSHAKE_TIMEOUT_MS = 5_000;
const LOCAL_UNAUTHENTICATED_MESSAGE = 'Authentication is required';
const LOCAL_NOT_READY_MESSAGE = 'WebSocket session is not ready';
const LOCAL_CONNECTION_MESSAGE = 'WebSocket session could not be established';

/** 本地阻止未认证连接时使用的脱敏固定错误。 */
export class WebSocketUnauthenticatedError extends Error {
  constructor() {
    super(LOCAL_UNAUTHENTICATED_MESSAGE);
    this.name = 'WebSocketUnauthenticatedError';
  }
}

/** 会话未 ready 时拒绝业务帧，不缓存也不重试。 */
export class WebSocketNotReadyError extends Error {
  constructor() {
    super(LOCAL_NOT_READY_MESSAGE);
    this.name = 'WebSocketNotReadyError';
  }
}

/** 不暴露服务端帧和底层异常的通用连接失败。 */
export class WebSocketConnectionError extends Error {
  constructor() {
    super(LOCAL_CONNECTION_MESSAGE);
    this.name = 'WebSocketConnectionError';
  }
}

export interface AuthenticatedWebSocketClientOptions {
  readonly coordinator: AuthInvalidationPort;
  readonly deviceId: string;
  readonly socketFactory: WebSocketFactory;
  readonly url: string;
  readonly handshakeTimeoutMs?: number;
  readonly requestIdFactory?: () => string;
}

/**
 * 认证连接只负责握手与状态门禁；不自动重连、不缓存业务帧。
 */
export class AuthenticatedWebSocketClient {
  private state: AuthenticatedWebSocketState = 'disconnected';
  private socket: WebSocketPort | undefined;
  private connection: Promise<SessionReady> | undefined;
  private resolveConnection: ((ready: SessionReady) => void) | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private requestCounter = 0;
  private connectionAttempt = 0;

  constructor(private readonly options: AuthenticatedWebSocketClientOptions) {}

  getState(): AuthenticatedWebSocketState {
    return this.state;
  }

  /** 重复连接复用当前握手，避免产生第二个 socket。 */
  connect(): Promise<SessionReady> {
    if (this.connection) {
      return this.connection;
    }
    if (this.options.coordinator.isInvalidating() || !isNonBlankString(this.options.deviceId)) {
      return Promise.reject(new WebSocketUnauthenticatedError());
    }

    this.state = 'connecting';
    this.connectionAttempt += 1;
    const attempt = this.connectionAttempt;
    const connection = new Promise<SessionReady>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    this.connection = connection;
    void this.open(attempt);
    return connection;
  }

  /** ready 前一律拒绝；业务层可按自身契约序列化 JSON。 */
  send(data: string | ArrayBuffer): void {
    if (this.state !== 'ready' || !this.socket) {
      throw new WebSocketNotReadyError();
    }
    this.socket.send(data);
  }

  /** close 可重复调用，且不会影响已被替换的连接。 */
  close(): void {
    this.disposeCurrent(new WebSocketConnectionError(), true);
  }

  private async open(attempt: number): Promise<void> {
    let token: string | undefined;
    try {
      token = await this.options.coordinator.getAccessToken();
    } catch {
      this.disposeAttempt(attempt, new WebSocketConnectionError(), false);
      return;
    }
    if (!this.isCurrentAttempt(attempt)) {
      return;
    }
    if (!token || this.options.coordinator.isInvalidating()) {
      this.disposeAttempt(attempt, new WebSocketUnauthenticatedError(), false);
      return;
    }

    const requestId = this.nextRequestId();
    let socket: WebSocketPort;
    try {
      socket = this.options.socketFactory(
        buildWebSocketUrl(this.options.url, this.options.deviceId),
      );
    } catch {
      this.disposeAttempt(attempt, new WebSocketConnectionError(), false);
      return;
    }

    this.socket = socket;
    this.state = 'authenticating';
    this.timeout = setTimeout(
      () => this.disposeCurrent(new WebSocketConnectionError(), true, socket),
      this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
    );
    socket.onopen = () => {
      if (socket !== this.socket) {
        return;
      }
      socket.send(
        JSON.stringify(
          createSessionHello({ accessToken: token, deviceId: this.options.deviceId, requestId }),
        ),
      );
    };
    socket.onmessage = (event) => this.handleMessage(socket, requestId, event.data);
    socket.onerror = () => this.disposeCurrent(new WebSocketConnectionError(), true, socket);
    socket.onclose = (event) => this.handleClose(socket, event.code);
  }

  private handleMessage(socket: WebSocketPort, requestId: string, rawData: unknown): void {
    if (socket !== this.socket || this.state !== 'authenticating' || typeof rawData !== 'string') {
      if (socket === this.socket && this.state === 'authenticating') {
        this.disposeCurrent(new WebSocketConnectionError(), true, socket);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.disposeCurrent(new WebSocketConnectionError(), true, socket);
      return;
    }
    const message = parseSessionServerMessage(parsed);
    if (!message || message.request_id !== requestId) {
      this.disposeCurrent(new WebSocketConnectionError(), true, socket);
      return;
    }

    if (message.type === 'session.error') {
      if (message.error.code === 'UNAUTHENTICATED') {
        void this.options.coordinator.invalidate('revoked');
      }
      this.disposeCurrent(new WebSocketConnectionError(), true, socket);
      return;
    }

    this.clearTimeout();
    this.state = 'ready';
    const resolve = this.resolveConnection;
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    resolve?.(message);
  }

  private handleClose(socket: WebSocketPort, _code: number | undefined): void {
    if (socket !== this.socket) {
      return;
    }
    this.disposeCurrent(new WebSocketConnectionError(), false, socket);
  }

  private disposeCurrent(error: Error, closeSocket: boolean, expectedSocket?: WebSocketPort): void {
    if (expectedSocket && expectedSocket !== this.socket) {
      return;
    }
    const socket = this.socket;
    this.clearTimeout();
    this.socket = undefined;
    this.state = 'disconnected';
    this.connectionAttempt += 1;
    const reject = this.rejectConnection;
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    this.connection = undefined;
    if (closeSocket && socket) {
      socket.close();
    }
    reject?.(error);
  }

  private disposeAttempt(attempt: number, error: Error, closeSocket: boolean): void {
    if (this.isCurrentAttempt(attempt)) {
      this.disposeCurrent(error, closeSocket);
    }
  }

  private isCurrentAttempt(attempt: number): boolean {
    return attempt === this.connectionAttempt && this.connection !== undefined;
  }

  private clearTimeout(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return this.options.requestIdFactory?.() ?? `session-hello-${this.requestCounter}`;
  }
}

/** URL 与 hello 复用同一 deviceId，避免网关上下文出现分裂。 */
export function buildWebSocketUrl(url: string, deviceId: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}device_id=${encodeURIComponent(deviceId)}`;
}

function isNonBlankString(value: string): boolean {
  return value.trim().length > 0;
}
