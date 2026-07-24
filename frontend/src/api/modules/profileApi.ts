import type { UserProfile, UserProfileRequest } from '../contracts/profile';
import { parseUserProfile } from '../contracts/validators';
import { HttpClient, httpClient } from '../core/http';

/** 负责个人主页的全局用户画像只读查询。 */
export class ProfileApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /**
   * 查询用户全局画像。对应 `GET /api/v1/user/profile`。
   * 画像写入统一通过 WriteRequestApi 的确认门禁完成。
   */
  getUserProfile(request: UserProfileRequest): Promise<UserProfile> {
    return this.http.request<UserProfile>(
      '/user/profile',
      {
        query: { ...request },
      },
      parseUserProfile,
    );
  }
}

export const profileApi = new ProfileApi();
