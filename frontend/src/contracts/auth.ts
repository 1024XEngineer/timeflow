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

/** 页面调用认证适配器时依赖的异步接口。 */
export type AuthAccess = (request: AuthAccessRequest) => Promise<AuthAccessResponse>;

/** 后端统一认证入口可能返回的业务错误码。 */
export type AuthErrorCode =
  'AUTH_INVALID_USERNAME' | 'AUTH_INVALID_PASSWORD' | 'AUTH_INVALID_CREDENTIALS';

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
