import type { QueryParams } from '../contracts/common';
import { ApiError } from './ApiError';
import type { ContractParser } from './validation';

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000/api/v1';

/** 从登录状态读取当前 Access Token，供受保护请求自动注入 Authorization。 */
export type AccessTokenProvider = () => Promise<string | null> | string | null;

/** 单次 HTTP 请求配置，扩展了查询参数、对象请求体和鉴权开关。 */
export interface HttpRequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | object | null;
  query?: QueryParams;
  authenticated?: boolean;
}

/** HttpClient 初始化配置，可替换地址、Token 来源和 fetch，便于 Mock 测试。 */
export interface HttpClientOptions {
  baseUrl?: string;
  getAccessToken?: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildQueryString(query?: QueryParams): string {
  if (!query) {
    return '';
  }

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      if (key === 'limit' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) {
        throw new ApiError(
          {
            code: 'INVALID_REQUEST',
            message: 'limit 必须是正整数',
            retryable: false,
            stage: 'request_validation',
          },
          { status: 400 },
        );
      }
      searchParams.append(key, String(value));
    }
  }

  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

function isBodyInit(body: BodyInit | object): body is BodyInit {
  return (
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function invalidResponseError(status: number, reason?: string): ApiError {
  return new ApiError(
    {
      code: 'CONTRACT_MISMATCH',
      message: reason
        ? `服务端返回了不符合统一接口契约的响应：${reason}`
        : '服务端返回了不符合统一接口契约的响应',
      retryable: false,
      stage: 'response_validation',
    },
    { status },
  );
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private getAccessToken?: AccessTokenProvider;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? API_BASE_URL);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.getAccessToken = options.getAccessToken;
  }

  setAccessTokenProvider(provider: AccessTokenProvider): void {
    this.getAccessToken = provider;
  }

  /**
   * 请求成功后直接校验接口自身的响应对象。
   *
   * 最新 Wiki 没有定义 `success/data/request_id/timestamp` HTTP 外层信封，
   * 因此 SDK 不再擅自包裹或解包响应；每个业务模块必须提供对应解析器。
   */
  async request<T>(
    path: string,
    options: HttpRequestOptions = {},
    parseData?: ContractParser<T>,
  ): Promise<T> {
    const response = await this.raw(path, options);

    if (response.status === 204) {
      return undefined as T;
    }

    let rawResponse: unknown;

    try {
      rawResponse = await response.json();
    } catch {
      throw invalidResponseError(response.status);
    }

    if (!response.ok) {
      const object =
        typeof rawResponse === 'object' && rawResponse !== null && !Array.isArray(rawResponse)
          ? (rawResponse as Record<string, unknown>)
          : {};
      throw new ApiError(
        {
          code: typeof object.error_code === 'string' ? object.error_code : 'HTTP_ERROR',
          message:
            typeof object.message === 'string'
              ? object.message
              : `HTTP 请求失败（${response.status}）`,
          retryable: response.status >= 500,
          stage: 'http_response',
        },
        { status: response.status },
      );
    }

    if (!parseData) {
      return rawResponse as T;
    }

    try {
      return parseData(rawResponse, 'response');
    } catch (error) {
      throw invalidResponseError(
        response.status,
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  /** 原样请求二进制或流式资源，不解析统一 JSON 信封。 */
  async raw(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const { authenticated = true, body, headers: suppliedHeaders, query, ...requestInit } = options;
    const headers = new Headers(suppliedHeaders);

    if (authenticated) {
      const token = await this.getAccessToken?.();

      if (!token) {
        throw new ApiError(
          {
            code: 'UNAUTHORIZED',
            message: '缺少 Access Token',
            retryable: false,
            stage: 'authentication',
          },
          { status: 401 },
        );
      }

      headers.set('Authorization', `Bearer ${token}`);
    }

    let requestBody: BodyInit | undefined;
    if (body !== undefined && body !== null) {
      if (isBodyInit(body)) {
        requestBody = body;
      } else {
        headers.set('Content-Type', 'application/json');
        requestBody = JSON.stringify(body);
      }
    }

    return this.fetchImpl(`${this.baseUrl}${normalizePath(path)}${buildQueryString(query)}`, {
      ...requestInit,
      body: requestBody,
      headers,
    });
  }
}

export const httpClient = new HttpClient();

/** 为默认 HTTP 单例配置登录令牌读取函数。 */
export function configureAccessTokenProvider(provider: AccessTokenProvider): void {
  httpClient.setAccessTokenProvider(provider);
}
