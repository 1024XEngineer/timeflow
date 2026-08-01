const LEGACY_BACKEND_USER_ID = 'default_user';

function isDevelopmentBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

/**
 * Decide whether the in-process FakeWsServer may be used when EXPO_PUBLIC_WS_URL is empty.
 *
 * - Explicit `true`/`1`: deliberate opt-in for any build (hosted web previews).
 * - Explicit `false`/`0`: always disabled.
 * - Unset: allowed only in `__DEV__` builds so store/production releases stay remote-only.
 */
export function resolveAllowFakeWs(
  flag: string | undefined,
  isDevBuild: boolean = isDevelopmentBuild(),
): boolean {
  const normalized = flag?.trim();
  if (normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  return isDevBuild;
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
