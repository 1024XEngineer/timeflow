import { isAuthAccessErrorCode, parseAuthErrorEnvelope } from '../../contracts/auth';

export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000/api/v1'
).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export class ApiResponseError extends Error {
  constructor(public readonly status: number) {
    super(`API response was not valid JSON for status ${status}`);
    this.name = 'ApiResponseError';
  }
}

/** 受保护请求在本地无法安全认证时使用的固定错误。 */
export class ApiUnauthenticatedError extends Error {
  constructor() {
    super('Authentication is required');
    this.name = 'ApiUnauthenticatedError';
  }
}

export type ApiAuthMode = 'public' | 'protected';

export interface ApiRequestInit extends RequestInit {
  readonly auth?: ApiAuthMode;
}

export type ApiRequest = <T>(path: string, init?: ApiRequestInit) => Promise<T>;

/** HTTP 客户端只依赖失效端口，不读取展示层或认证存储。 */
export interface AuthInvalidationPort {
  getAccessToken(): Promise<string | undefined>;
  invalidate(reason: 'expired' | 'revoked'): Promise<void>;
  isInvalidating(): boolean;
  shouldInvalidateOnUnauthenticated(): boolean;
}

export interface CreateApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly invalidationCoordinator?: AuthInvalidationPort;
}

/** 创建显式公开/受保护请求的底层 client；默认保护业务资源。 */
export function createApiClient(options: CreateApiClientOptions = {}): ApiRequest {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return async <T>(path: string, init: ApiRequestInit = {}): Promise<T> => {
    const auth = init.auth ?? 'protected';
    const headers = new Headers(init.headers);

    if (auth === 'public') {
      headers.delete('Authorization');
    } else {
      const token = await getProtectedToken(options.invalidationCoordinator);
      headers.set('Authorization', `Bearer ${token}`);
    }

    const { auth: _auth, ...requestInit } = init;
    const response = await fetchImplementation(`${API_BASE_URL}${path}`, {
      ...requestInit,
      headers,
    });

    if (!response.ok) {
      const body = await readJson(response);
      if (auth === 'protected' && response.status === 401) {
        const code = parseAuthErrorEnvelope(body)?.error.code;
        if (
          isAuthAccessErrorCode(code) &&
          options.invalidationCoordinator?.shouldInvalidateOnUnauthenticated()
        ) {
          await options.invalidationCoordinator.invalidate('revoked');
        }
      }
      throw new ApiError(response.status, body);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiResponseError(response.status);
    }
  };
}

/** 公开入口强制移除 Authorization，调用方无法意外带入旧凭据。 */
export function createPublicApiClient(options: CreateApiClientOptions = {}): ApiRequest {
  const request = createApiClient(options);
  return <T>(path: string, init?: ApiRequestInit) => request<T>(path, { ...init, auth: 'public' });
}

/** 受保护入口统一走 Token 读取和严格 401 失效分类。 */
export function createProtectedApiClient(options: CreateApiClientOptions): ApiRequest {
  const request = createApiClient(options);
  return <T>(path: string, init?: ApiRequestInit) =>
    request<T>(path, { ...init, auth: 'protected' });
}

async function getProtectedToken(coordinator: AuthInvalidationPort | undefined): Promise<string> {
  if (!coordinator || coordinator.isInvalidating()) {
    throw new ApiUnauthenticatedError();
  }

  const token = await coordinator.getAccessToken();
  if (!token || coordinator.isInvalidating()) {
    throw new ApiUnauthenticatedError();
  }
  return token;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
