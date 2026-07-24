import type { JsonObject, UUID } from './common';

/** 查询当前用户全局画像时显式携带用户 ID。 */
export interface UserProfileRequest {
  user_id: UUID;
}

/**
 * 最新 Wiki 引用了 UserProfileDTO，但尚未声明字段表。
 * 当前只保证响应是 JSON 对象，避免把测试样例误当成正式结构。
 */
export type UserProfile = JsonObject;
