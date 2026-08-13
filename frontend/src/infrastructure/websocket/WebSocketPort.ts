/** 浏览器和 React Native 共同具备的最小 WebSocket 表面。 */
export interface WebSocketPort {
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  onerror: ((event: WebSocketErrorEvent) => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  close(code?: number): void;
  send(data: string | ArrayBuffer): void;
}

export interface WebSocketCloseEvent {
  readonly code?: number;
}

export interface WebSocketErrorEvent {
  readonly type?: string;
}

export interface WebSocketMessageEvent {
  readonly data: unknown;
}

export type WebSocketFactory = (url: string) => WebSocketPort;
