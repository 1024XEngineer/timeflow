import type { AuthAccess, AuthAccessRequest } from '../../../contracts/auth';

export const MOCK_PREVIEW_ACCOUNT_ID = 'mock-account-001';
export const MOCK_PREVIEW_USERNAME = '示例用户';
export const MOCK_PREVIEW_PASSWORD = 'preview12';
export const MOCK_PREVIEW_ACCESS_TOKEN = 'mock-preview-token';

export const MOCK_PREVIEW_CREDENTIALS: AuthAccessRequest = {
  password: MOCK_PREVIEW_PASSWORD,
  username: MOCK_PREVIEW_USERNAME,
};

/** 预览用认证入口：不发网络请求，任意通过本地校验的凭据都进入示例账号。 */
export function createMockAuthAccess(): AuthAccess {
  return async () => ({
    account_id: MOCK_PREVIEW_ACCOUNT_ID,
    access_token: MOCK_PREVIEW_ACCESS_TOKEN,
    expires_in: 60 * 60 * 24 * 7,
  });
}
