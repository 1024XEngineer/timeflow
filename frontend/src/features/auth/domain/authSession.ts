import { isAuthAccessResponse } from '../../../contracts/auth';

const MILLISECONDS_PER_SECOND = 1000;
const EXPIRY_SKEW_MS = 30_000;
const INVALID_AUTH_ACCESS_RESPONSE_MESSAGE = 'Invalid authentication access response';
export const LOCAL_PREVIEW_ACCOUNT_ID = 'preview_local';
export const LOCAL_PREVIEW_USERNAME = '本地预览';
const LOCAL_PREVIEW_ACCESS_TOKEN = 'preview-local-session';
const LOCAL_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** 已通过认证且可持久化的最小会话；访问令牌保持 opaque，不在客户端解释。 */
export interface AuthSession {
  readonly accountId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly username: string;
}

/** 应用层认证状态；加载失败只在初始化分支携带可展示信息。 */
export type AuthState =
  | { status: 'loading'; initializationError?: string }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; session: AuthSession };

/** 展示层只接收账号标识，不接触敏感访问令牌。 */
export type AuthViewState =
  | { status: 'loading'; initializationError?: string }
  | { status: 'unauthenticated' }
  | { status: 'authenticated'; accountId: string; username: string };

/** 将服务端认证响应收敛为与服务端有效期一致的领域会话。 */
export function createAuthSession(response: unknown, username: unknown, now: number): AuthSession {
  if (!isAuthAccessResponse(response) || !isNonBlankString(username)) {
    throw new Error(INVALID_AUTH_ACCESS_RESPONSE_MESSAGE);
  }

  return {
    accountId: response.account_id,
    accessToken: response.access_token,
    expiresAt: now + response.expires_in * MILLISECONDS_PER_SECOND,
    username: username.trim(),
  };
}

/** 无后端时的本地预览会话：只打开本地日历，令牌不能当线上凭据用。 */
export function createLocalPreviewSession(now: number): AuthSession {
  return {
    accountId: LOCAL_PREVIEW_ACCOUNT_ID,
    accessToken: LOCAL_PREVIEW_ACCESS_TOKEN,
    expiresAt: now + LOCAL_PREVIEW_TTL_MS,
    username: LOCAL_PREVIEW_USERNAME,
  };
}

/** 本地预览令牌过不了线上握手；不能把它当成真实会话被吊销。 */
export function isLocalPreviewSession(session: AuthSession): boolean {
  return session.accountId === LOCAL_PREVIEW_ACCOUNT_ID;
}

/** 校验未知输入是否具备可安全使用的会话字段。 */
export function isAuthSession(value: unknown): value is AuthSession {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOwnProperty(value, 'accountId') &&
    hasOwnProperty(value, 'accessToken') &&
    hasOwnProperty(value, 'expiresAt') &&
    hasOwnProperty(value, 'username') &&
    isNonBlankString(value.accountId) &&
    isNonBlankString(value.accessToken) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    isNonBlankString(value.username)
  );
}

/** 在到期前保留安全裕量，避免调用链中途使用即将失效的令牌。 */
export function isObviouslyExpired(session: AuthSession, now: number): boolean {
  return session.expiresAt <= now + EXPIRY_SKEW_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnProperty(record: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
