import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketMessageEvent,
  WebSocketPort,
} from '../../src/infrastructure/websocket/WebSocketPort';

/** WebSocket 单元测试唯一可控 Fake，显式驱动连接事件。 */
export class FakeWebSocket implements WebSocketPort {
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  readonly sent: (string | ArrayBuffer)[] = [];
  closeCalls = 0;

  close(code?: number): void {
    this.closeCalls += 1;
    this.onclose?.({ code });
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  open(): void {
    this.onopen?.();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.onerror?.({ type: 'error' });
  }

  closeFromServer(code?: number): void {
    this.onclose?.({ code });
  }
}
