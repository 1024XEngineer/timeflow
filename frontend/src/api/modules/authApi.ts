import type { AuthSession, CurrentUser, LoginRequest, RegisterRequest } from '../contracts/auth';
import { parseAuthSession, parseCurrentUser } from '../contracts/validators';
import { HttpClient, httpClient } from '../core/http';

/** 负责账号注册、登录和当前用户初始化查询。 */
export class AuthApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /** 创建用户账号并返回登录令牌。对应 `POST /api/v1/auth/register`。 */
  register(request: RegisterRequest): Promise<AuthSession> {
    return this.http.request<AuthSession>(
      '/auth/register',
      {
        authenticated: false,
        body: request,
        method: 'POST',
      },
      parseAuthSession,
    );
  }

  /** 使用邮箱密码建立登录态。对应 `POST /api/v1/auth/login`。 */
  login(request: LoginRequest): Promise<AuthSession> {
    return this.http.request<AuthSession>(
      '/auth/login',
      {
        authenticated: false,
        body: request,
        method: 'POST',
      },
      parseAuthSession,
    );
  }

  /** 获取页面初始化需要的当前用户信息。对应 `GET /api/v1/auth/me`。 */
  getCurrentUser(): Promise<CurrentUser> {
    return this.http.request<CurrentUser>('/auth/me', {}, parseCurrentUser);
  }
}

export const authApi = new AuthApi();
