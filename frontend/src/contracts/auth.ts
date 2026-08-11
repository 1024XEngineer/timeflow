export interface AuthAccessRequest {
  username: string;
  password: string;
}

export interface AuthAccessResponse {
  account_id: string;
  access_token: string;
  expires_in: number;
}

export type AuthAccess = (request: AuthAccessRequest) => Promise<AuthAccessResponse>;

export type AuthErrorCode =
  'AUTH_INVALID_USERNAME' | 'AUTH_INVALID_PASSWORD' | 'AUTH_INVALID_CREDENTIALS';

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
