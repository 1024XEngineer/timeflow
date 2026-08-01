const LEGACY_BACKEND_USER_ID = 'default_user';

export function buildSessionWebSocketUrl(baseUrl: string, deviceId: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('EXPO_PUBLIC_WS_URL 必须使用 ws:// 或 wss://');
  }
  url.searchParams.set('device_id', deviceId);
  return url.toString();
}

/** Current MVP backend owns a single default user but omits it from session.ready. */
export function resolveSessionUserId(userId: unknown): string {
  return typeof userId === 'string' && userId.trim() ? userId.trim() : LEGACY_BACKEND_USER_ID;
}
