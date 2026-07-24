import type { UUID } from './common';

/** 创建 TimeFlow 用户账号。最新版接口不再要求前端提交 timezone。 */
export interface RegisterRequest {
  email: string;
  password: string;
  display_name: string;
}

/** 使用邮箱和密码建立登录态。 */
export interface LoginRequest {
  email: string;
  password: string;
}

/** 注册或登录成功后返回的最新版认证结果。 */
export interface AuthSession {
  user_id: UUID;
  business_user_id: string;
  access_token: string;
}

/** 页面初始化时使用的当前用户最小展示信息。 */
export interface CurrentUser {
  user_id: UUID;
  business_user_id: string;
  display_name: string;
}
