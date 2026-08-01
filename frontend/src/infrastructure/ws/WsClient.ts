import type { ConnectionStatus, WsJsonMessage } from '@/contracts';

export type { ConnectionStatus, WsJsonMessage } from '@/contracts';

export type WsClientOptions = {
  /** 真实后端地址；为空则走 fakeHandler 进程内通道。 */
  url?: string | null;
  /** 无 URL 时的进程内消息处理器（由 SessionProvider 在显式 Fake 模式下注入）。 */
  fakeHandler?: (message: WsJsonMessage | ArrayBuffer) => void | Promise<void>;
  requestTimeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: WsJsonMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  isMatch: (response: WsJsonMessage) => boolean;
};

/**
 * 契约对齐的 WS 客户端：按 request_id 等待响应，支持订阅推送与二进制帧。
 * 无 URL 时走进程内 Fake 通道，便于本地与单测。
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(message: WsJsonMessage | ArrayBuffer) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private status: ConnectionStatus = 'idle';
  private readonly requestTimeoutMs: number;
  private readonly url: string | null;
  private readonly fakeHandler?: (message: WsJsonMessage | ArrayBuffer) => void | Promise<void>;
  private fakeReply: ((message: WsJsonMessage | ArrayBuffer) => void) | null = null;
  private intentionallyClosed = false;
  /** Invalidates callbacks belonging to a socket that has been replaced. */
  private socketGeneration = 0;
  private connecting: { generation: number; reject: (error: Error) => void } | null = null;

  constructor(options: WsClientOptions = {}) {
    this.url = options.url?.trim() || null;
    this.fakeHandler = options.fakeHandler;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onMessage(listener: (message: WsJsonMessage | ArrayBuffer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    if (!this.url) {
      this.setStatus('connecting');
      this.fakeReply = (message) => this.dispatch(message);
      this.setStatus('ready');
      return;
    }

    this.setStatus(this.status === 'ready' ? 'reconnecting' : 'connecting');
    await new Promise<void>((resolve, reject) => {
      const generation = ++this.socketGeneration;
      const socket = new WebSocket(this.url!);
      this.socket = socket;
      this.connecting = { generation, reject };
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        if (this.socket !== socket || this.socketGeneration !== generation) return;
        this.connecting = null;
        this.setStatus('ready');
        resolve();
      };
      socket.onerror = () => {
        if (this.socket !== socket || this.socketGeneration !== generation) return;
        const error = new Error('WebSocket connection failed');
        this.setStatus('error');
        this.rejectPending(error);
        this.rejectConnecting(generation, error);
      };
      socket.onclose = () => {
        const isCurrent = this.socket === socket && this.socketGeneration === generation;
        if (!isCurrent) return;
        this.socket = null;
        if (this.intentionallyClosed) return;
        const error = new Error('WebSocket closed unexpectedly');
        this.rejectPending(error);
        this.setStatus('closed');
        this.rejectConnecting(generation, new Error('WebSocket closed before becoming ready'));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket || this.socketGeneration !== generation) return;
        if (typeof event.data === 'string') {
          try {
            this.dispatch(JSON.parse(event.data) as WsJsonMessage);
          } catch {
            // ignore malformed JSON
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          this.dispatch(event.data);
        }
      };
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.rejectConnecting(this.socketGeneration, new Error('WebSocket closed'));
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.fakeReply = null;
    this.rejectPending(new Error('WebSocket closed'));
    this.setStatus('closed');
  }

  sendJson(message: WsJsonMessage): void {
    if (!this.url) {
      void Promise.resolve(this.fakeHandler?.(message)).catch((error) => {
        if (message.request_id) {
          this.rejectRequest(
            message.request_id,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.socket.send(JSON.stringify(message));
  }

  sendBinary(data: ArrayBuffer): void {
    if (!this.url) {
      void Promise.resolve(this.fakeHandler?.(data)).catch(() => undefined);
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.socket.send(data);
  }

  /** Fake 服务端向客户端推送。 */
  emitFromServer(message: WsJsonMessage | ArrayBuffer): void {
    this.fakeReply?.(message);
  }

  request<T extends WsJsonMessage>(
    message: WsJsonMessage & { request_id: string },
    isMatch: (response: WsJsonMessage) => boolean = (response) =>
      response.request_id === message.request_id,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!message.request_id) {
        reject(new Error(`Request id is required: ${message.type}`));
        return;
      }
      if (this.pending.has(message.request_id)) {
        reject(new Error(`Duplicate request id: ${message.request_id}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(message.request_id);
        reject(new Error(`Request timed out: ${message.type}`));
      }, this.requestTimeoutMs);

      this.pending.set(message.request_id, {
        isMatch,
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(message.request_id);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(message.request_id);
          reject(error);
        },
        timer,
      });

      try {
        this.sendJson(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private dispatch(message: WsJsonMessage | ArrayBuffer): void {
    if (!(message instanceof ArrayBuffer)) {
      for (const pending of this.pending.values()) {
        if (pending.isMatch(message)) {
          pending.resolve(message);
          break;
        }
      }
    }
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private rejectRequest(requestId: string, error: Error): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(requestId);
    request.reject(error);
  }

  private rejectConnecting(generation: number, error: Error): void {
    const connecting = this.connecting;
    if (!connecting || connecting.generation !== generation) return;
    this.connecting = null;
    connecting.reject(error);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
