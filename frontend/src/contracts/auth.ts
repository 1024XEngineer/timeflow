/**
 * 账号创建或登录统一入口使用的线上认证协议。
 *
 * 本文件只描述页面、认证适配器和后端之间共享的传输结构，不保存表单状态，
 * 也不暴露具体 HTTP 客户端的错误类型。
 */

/** 提交给统一认证入口的用户名和密码。 */
export interface AuthAccessRequest {
  username: string;
  password: string;
}

/** 账号创建或登录成功后返回的访问凭据。 */
export interface AuthAccessResponse {
  account_id: string;
  access_token: string;
  /** 访问令牌从签发时刻起的有效秒数。 */
  expires_in: number;
}

/** 验证统一认证入口返回的完整访问凭据。 */
export function isAuthAccessResponse(value: unknown): value is AuthAccessResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOwnProperty(value, 'account_id') &&
    hasOwnProperty(value, 'access_token') &&
    hasOwnProperty(value, 'expires_in') &&
    isNonBlankString(value.account_id) &&
    isNonBlankString(value.access_token) &&
    value.expires_in === 3600
  );
}

/** 页面调用认证适配器时依赖的异步接口。 */
export type AuthAccess = (request: AuthAccessRequest) => Promise<AuthAccessResponse>;

/** 后端统一认证入口可能返回的业务错误码。 */
export const AUTH_INVALID_USERNAME = 'AUTH_INVALID_USERNAME';
export const AUTH_INVALID_PASSWORD = 'AUTH_INVALID_PASSWORD';
export const AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS';
export const AUTH_REQUIRED = 'AUTH_REQUIRED';
export const AUTH_INVALID_TOKEN = 'AUTH_INVALID_TOKEN';
export const AUTH_INTERNAL_ERROR = 'AUTH_INTERNAL_ERROR';

/** 冻结认证错误码，客户端只接受契约内的值。 */
export const AUTH_ERROR_CODES = Object.freeze([
  AUTH_INVALID_USERNAME,
  AUTH_INVALID_PASSWORD,
  AUTH_INVALID_CREDENTIALS,
  AUTH_REQUIRED,
  AUTH_INVALID_TOKEN,
  AUTH_INTERNAL_ERROR,
] as const);

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** 冻结 HTTP 错误外壳，避免调用方依赖传输层错误对象。 */
export interface AuthErrorEnvelope {
  readonly error: {
    readonly code: AuthErrorCode;
    readonly message: string;
  };
}

/** 严格读取冻结的嵌套错误外壳；拒绝旧顶层形状和原型链字段。 */
export function parseAuthErrorEnvelope(value: unknown): AuthErrorEnvelope | undefined {
  if (!isRecord(value) || !hasOwnProperty(value, 'error') || !isRecord(value.error)) {
    return undefined;
  }

  const error = value.error;
  if (
    !hasOwnProperty(error, 'code') ||
    !hasOwnProperty(error, 'message') ||
    !isAuthErrorCode(error.code) ||
    !isNonBlankString(error.message)
  ) {
    return undefined;
  }

  return { error: { code: error.code, message: error.message } };
}

/** 只有明确的访问凭据失效码可以驱动本地会话清理。 */
export function isAuthAccessErrorCode(
  value: unknown,
): value is typeof AUTH_REQUIRED | typeof AUTH_INVALID_TOKEN {
  return value === AUTH_REQUIRED || value === AUTH_INVALID_TOKEN;
}

/** 页面能够稳定处理的认证失败分类。 */
export type AuthAccessFailureReason = 'business' | 'invalid_response' | 'network' | 'timeout';

/** 将认证失败归一化，避免页面依赖 fetch 或具体 HTTP 客户端。 */
export class AuthAccessError extends Error {
  constructor(
    public readonly reason: AuthAccessFailureReason,
    public readonly code?: AuthErrorCode,
  ) {
    super(code ?? reason);
    this.name = 'AuthAccessError';
  }
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

function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === 'string' && AUTH_ERROR_CODES.includes(value as AuthErrorCode);
}
