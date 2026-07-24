export type UUID = string;
export type ISODate = string;
export type ISODateTime = string;
export type RequestId = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * 前端本地统一错误结构。
 *
 * 最新 Wiki 只冻结了部分 WebSocket 错误载荷，尚未定义 HTTP 错误响应信封；
 * 因此该类型只用于 SDK 抛错，不表示服务端固定响应格式。
 */
export interface ApiErrorDetail {
  code: string;
  message: string;
  stage: string;
  retryable: boolean;
}

export type QueryValue = boolean | number | string | null | undefined;
export type QueryParams = Record<string, QueryValue>;
