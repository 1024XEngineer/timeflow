/** 生成 WS 请求 ID：`prefix_timestamp_random`。 */
export function nextRequestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
