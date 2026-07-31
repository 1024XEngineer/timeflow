import type { WsJsonMessage } from '@/contracts';

/**
 * schedule data 层所需的最小传输面。
 * app 注入 WsClient；feature 不依赖 SessionProvider。
 */
export type ScheduleTransport = {
  onMessage(listener: (message: WsJsonMessage | ArrayBuffer) => void): () => void;
  request<T extends WsJsonMessage>(
    message: WsJsonMessage & { request_id: string },
    isMatch?: (response: WsJsonMessage) => boolean,
  ): Promise<T>;
  sendJson(message: WsJsonMessage): void;
};
