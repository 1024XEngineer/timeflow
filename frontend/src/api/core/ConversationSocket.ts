import type { ConversationClientEvent, ConversationServerEvent } from '../contracts/conversation';
import {
  parseConversationClientEvent,
  parseConversationServerEvent,
} from '../contracts/validators';
import { ApiError } from './ApiError';

export const CONVERSATION_WS_URL =
  process.env.EXPO_PUBLIC_WS_URL ??
  (process.env.EXPO_PUBLIC_API_URL
    ? process.env.EXPO_PUBLIC_API_URL.replace(/^http/, 'ws').replace(
        /\/api\/v1\/?$/,
        '/ws/v1/conversation',
      )
    : 'ws://127.0.0.1:8000/ws/v1/conversation');

type ReactNativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => WebSocket;

/** 实时会话连接配置及页面事件回调。 */
export interface ConversationSocketOptions {
  accessToken: string;
  url?: string;
  onEvent: (event: ConversationServerEvent) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

export type ConversationCloseDisposition = 'closed' | 'reauthenticate' | 'reconnect';

/**
 * 按最新版 Wiki 的 close code 约定判断页面下一步动作。
 * 1000/1001 正常结束，1008 重新认证，1011、1006 或非 clean 关闭需要重连。
 */
export function classifyConversationClose(event: CloseEvent): ConversationCloseDisposition {
  if (event.code === 1008) {
    return 'reauthenticate';
  }
  if (event.code === 1011 || event.code === 1006 || !event.wasClean) {
    return 'reconnect';
  }
  return 'closed';
}

export class ConversationSocket {
  private readonly options: ConversationSocketOptions;
  private socket: WebSocket | null = null;

  constructor(options: ConversationSocketOptions) {
    this.options = options;
  }

  /** 建立 `/ws/v1/conversation` 连接，并在握手 Header 中注入 Access Token。 */
  connect(): void {
    if (
      this.socket?.readyState === WebSocket.CONNECTING ||
      this.socket?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    const Socket = WebSocket as unknown as ReactNativeWebSocketConstructor;
    const socket = new Socket(this.options.url ?? CONVERSATION_WS_URL, undefined, {
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
      },
    });

    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') {
        return;
      }

      try {
        // 服务端事件只有通过运行时契约校验后才会交给页面处理。
        const event = parseConversationServerEvent(JSON.parse(message.data));
        this.options.onEvent(event);
      } catch {
        this.options.onEvent({
          type: 'execution.error',
          timestamp: new Date().toISOString(),
          payload: {
            error_code: 'CONTRACT_MISMATCH',
            message: 'WebSocket 返回了无法解析的事件',
          },
        });
      }
    };
    socket.onclose = (event) => this.options.onClose?.(event);
    socket.onerror = (event) => this.options.onError?.(event);
    this.socket = socket;
  }

  /** 重连成功后请求续接上次已读消息之后遗漏的流式事件。 */
  resume(lastSeenMessageId: string): void {
    this.send({
      type: 'transport.resume',
      timestamp: new Date().toISOString(),
      payload: {
        last_seen_message_id: lastSeenMessageId,
      },
    });
  }

  /** 校验并发送一个客户端事件；非法结构会在发送前被拒绝。 */
  send(event: ConversationClientEvent): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Conversation WebSocket is not connected');
    }

    try {
      // 在真正发送前校验信封和 payload，避免错误事件进入主 Agent 流程。
      this.socket.send(JSON.stringify(parseConversationClientEvent(event)));
    } catch (error) {
      throw new ApiError(
        {
          code: 'CONTRACT_MISMATCH',
          message: `WebSocket 入站事件不符合统一接口契约：${
            error instanceof Error ? error.message : '未知校验错误'
          }`,
          retryable: false,
          stage: 'request_validation',
        },
        { status: 0 },
      );
    }
  }

  /** 主动关闭会话连接并释放当前 WebSocket 实例。 */
  close(code?: number, reason?: string): void {
    this.socket?.close(code, reason);
    this.socket = null;
  }
}
