/**
 * WS 信封的共享部分：所有 `voice.*`/`session.*` 消息都长这个骨架，具体消息类型
 * 见 `conversation.ts`。字段名和后端 `gateway/websocket/messages/*.py`
 * 与 `envelope.py` 逐字对齐，改动需要两边一起改。
 */

/** 失败信封携带的错误体，与 `envelope.py::ErrorDetail` 对齐。 */
export interface TransportErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
}

/** 握手、路由等失败时收到的通用失败信封。 */
export interface TransportErrorEnvelope {
  type: string;
  ok: false;
  error: TransportErrorDetail;
  request_id?: string;
  conversation_id?: string;
}

/** 客户端到服务端消息的公共字段。 */
export interface OutgoingEnvelope<Type extends string, Payload> {
  type: Type;
  request_id?: string;
  payload: Payload;
}
