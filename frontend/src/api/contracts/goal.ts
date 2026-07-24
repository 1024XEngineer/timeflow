import type { ISODateTime, UUID } from './common';
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

/** 长任务创建时确认落盘的任务级画像快照。 */
export interface TaskProfileSnapshot {
  id: UUID;
  user_id: UUID;
  long_goal_id: UUID;
  profile_summary: string;
  source_message_id: UUID;
  version: number;
}

/**
 * `GET /long-goals/{goal_id}` 的完整响应。
 */
export interface LongGoalDetailResult {
  goal: LongGoal;
  subtasks: TaskItem[];
  task_profile: TaskProfileSnapshot | null;
}
