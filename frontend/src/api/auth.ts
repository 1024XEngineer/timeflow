import {
  AuthAccessError,
  type AuthAccess,
  type AuthAccessResponse,
  type AuthErrorCode,
} from '../contracts/auth';
import {
  ApiError,
  ApiResponseError,
  apiFetch,
  type ApiRequest,
} from '../infrastructure/network/client';

const AUTH_ACCESS_TIMEOUT_MS = 15_000;

const AUTH_ERROR_CODES = new Set<AuthErrorCode>([
  'AUTH_INVALID_USERNAME',
  'AUTH_INVALID_PASSWORD',
  'AUTH_INVALID_CREDENTIALS',
]);

/** 纯前端传输适配器；账号创建或密码校验均由服务端统一接口决定。 */
export function createAuthAccess(request: ApiRequest = apiFetch): AuthAccess {
  return async (credentials) => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), AUTH_ACCESS_TIMEOUT_MS);

    try {
      const response = await request<unknown>('/auth/access', {
        body: JSON.stringify(credentials),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: abortController.signal,
      });

      // 只有完整 Token 响应才能进入页面的成功回调，避免伪造或误判登录成功。
      if (!isAuthAccessResponse(response)) {
        throw new AuthAccessError('invalid_response');
      }

      return response;
    } catch (error) {
      if (error instanceof AuthAccessError) {
        throw error;
      }
      if (error instanceof ApiError) {
        throw new AuthAccessError('business', readAuthErrorCode(error.body));
      }
      if (error instanceof ApiResponseError) {
        throw new AuthAccessError('invalid_response');
      }
      if (isAbortError(error)) {
        throw new AuthAccessError('timeout');
      }
      throw new AuthAccessError('network');
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

export const accessAuth = createAuthAccess();

function isAuthAccessResponse(value: unknown): value is AuthAccessResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonBlankString(value.account_id) &&
    isNonBlankString(value.access_token) &&
    typeof value.expires_in === 'number' &&
    Number.isFinite(value.expires_in) &&
    value.expires_in > 0
  );
}

function readAuthErrorCode(body: unknown): AuthErrorCode | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  // 定义了错误码但未限定 JSON 外壳，因此兼容两种常见响应结构。
  const candidate = isRecord(body.error) ? body.error.code : body.code;
  return typeof candidate === 'string' && AUTH_ERROR_CODES.has(candidate as AuthErrorCode)
    ? (candidate as AuthErrorCode)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}
