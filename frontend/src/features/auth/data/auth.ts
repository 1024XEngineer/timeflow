import {
  AuthAccessError,
  isAuthAccessResponse,
  type AuthAccess,
  type AuthErrorCode,
} from '../../../contracts/auth';
import {
  ApiError,
  ApiResponseError,
  apiFetch,
  type ApiRequest,
} from '../../../infrastructure/network/client';

const AUTH_ACCESS_TIMEOUT_MS = 15_000;

const AUTH_ERROR_CODES = new Set<AuthErrorCode>([
  'AUTH_INVALID_USERNAME',
  'AUTH_INVALID_PASSWORD',
  'AUTH_INVALID_CREDENTIALS',
]);

/** 统一认证请求适配器；账号创建或密码校验均由服务端统一入口决定。 */
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

// 公开单例供默认组装使用；测试和定制组装仍通过工厂注入请求实现。
export const accessAuth = createAuthAccess();

function readAuthErrorCode(body: unknown): AuthErrorCode | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const candidate = isRecord(body.error) ? body.error.code : body.code;
  return typeof candidate === 'string' && AUTH_ERROR_CODES.has(candidate as AuthErrorCode)
    ? (candidate as AuthErrorCode)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}
