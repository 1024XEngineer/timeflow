import type { ISODateTime, JsonObject, UUID } from './common';
import type { TaskItem } from './item';

export type LongGoalStatus = 'active' | 'completed' | 'cancelled';

/** 长任务目标管理 Tab 使用的长目标结构。 */
export interface LongGoal {
  id: UUID;
  user_id: UUID;
  title: string;
  description?: string | null;
  plan_overview?: string | null;
  start_at?: ISODateTime | null;
  deadline_at?: ISODateTime | null;
  status: LongGoalStatus;
  version: number;
}

/** 按用户和可选状态查询长目标列表。 */
export interface LongGoalListRequest {
  user_id: UUID;
  status?: LongGoalStatus;
}

/** `GET /long-goals` 的完整响应。 */
export interface LongGoalListResult {
  goals: LongGoal[];
}

/** 查询单个长目标详情时使用的身份参数。 */
export interface LongGoalDetailRequest {
  user_id: UUID;
}

/**
 * `GET /long-goals/{goal_id}` 的完整响应。
 *
 * 最新 Wiki 只命名了 `task_profile`，未冻结 UserProfileDTO 的内部字段，
 * 因此该字段保持 JSON 对象，不把 Mock 内容升级成正式契约。
 */
export interface LongGoalDetailResult {
  goal: LongGoal;
  subtasks: TaskItem[];
  task_profile: JsonObject | null;
}
