const LEGACY_BACKEND_USER_ID = 'default_user';

function isDevelopmentBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

export function buildSessionWebSocketUrl(
  baseUrl: string,
  deviceId: string,
  options: { allowInsecure?: boolean } = {},
): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('EXPO_PUBLIC_WS_URL 必须使用 ws:// 或 wss://');
  }
  const allowInsecure = options.allowInsecure ?? isDevelopmentBuild();
  if (url.protocol === 'ws:' && !allowInsecure) {
    throw new Error('发布构建的 EXPO_PUBLIC_WS_URL 必须使用 wss://');
  }
  url.searchParams.set('device_id', deviceId);
  return url.toString();
}

/** Current MVP backend owns a single default user but omits it from session.ready. */
export function resolveSessionUserId(userId: unknown): string {
  return typeof userId === 'string' && userId.trim() ? userId.trim() : LEGACY_BACKEND_USER_ID;
}
