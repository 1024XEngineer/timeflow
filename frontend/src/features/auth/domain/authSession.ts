import { isAuthAccessResponse } from '../../../contracts/auth';

const AUTH_SESSION_TTL_MS = 3_600_000;
const EXPIRY_SKEW_MS = 30_000;
const INVALID_AUTH_ACCESS_RESPONSE_MESSAGE = 'Invalid authentication access response';

/** 已通过认证且可持久化的最小会话；访问令牌保持 opaque，不在客户端解释。 */
export interface AuthSession {
  readonly accountId: string;
  readonly accessToken: string;
  readonly expiresAt: number;
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
  | { status: 'authenticated'; accountId: string };

/** 将服务端认证响应收敛为带固定生命周期的领域会话。 */
export function createAuthSession(response: unknown, now: number): AuthSession {
  if (!isAuthAccessResponse(response)) {
    throw new Error(INVALID_AUTH_ACCESS_RESPONSE_MESSAGE);
  }

  return {
    accountId: response.account_id,
    accessToken: response.access_token,
    expiresAt: now + AUTH_SESSION_TTL_MS,
  };
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
    isNonBlankString(value.accountId) &&
    isNonBlankString(value.accessToken) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
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
