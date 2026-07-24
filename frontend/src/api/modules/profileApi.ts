import type { UserProfile, UserProfileRequest } from '../contracts/profile';
import { parseUserProfile, parseUserProfileRequest } from '../contracts/validators';
import { HttpClient, httpClient, validateRequest } from '../core/http';

/** 负责个人主页的全局用户画像只读查询。 */
export class ProfileApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /**
   * 查询用户全局画像。对应 `GET /api/v1/user/profile`。
   * 画像写入统一通过 WriteRequestApi 的确认门禁完成。
   */
  getUserProfile(request: UserProfileRequest): Promise<UserProfile> {
    const validatedRequest = validateRequest(request, parseUserProfileRequest);
    return this.http.request<UserProfile>(
      '/user/profile',
      {
        query: { ...validatedRequest },
      },
      parseUserProfile,
    );
  }
}

export const profileApi = new ProfileApi();
