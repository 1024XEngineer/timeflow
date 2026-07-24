import type {
  LongGoalDetailRequest,
  LongGoalDetailResult,
  LongGoalListRequest,
  LongGoalListResult,
} from '../contracts/goal';
import type { UUID } from '../contracts/common';
import { parseLongGoalDetailResult, parseLongGoalListResult } from '../contracts/validators';
import { HttpClient, httpClient } from '../core/http';

/** 负责长任务目标管理 Tab 的列表和详情查询。 */
export class GoalApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /** 查询当前用户的长目标列表。对应 `GET /api/v1/long-goals`。 */
  getLongGoals(request: LongGoalListRequest): Promise<LongGoalListResult> {
    return this.http.request<LongGoalListResult>(
      '/long-goals',
      {
        query: { ...request },
      },
      parseLongGoalListResult,
    );
  }

  /** 查询一个长目标、其子任务和任务画像。对应 `GET /long-goals/{goal_id}`。 */
  getLongGoal(goalId: UUID, request: LongGoalDetailRequest): Promise<LongGoalDetailResult> {
    return this.http.request<LongGoalDetailResult>(
      `/long-goals/${encodeURIComponent(goalId)}`,
      {
        query: { ...request },
      },
      parseLongGoalDetailResult,
    );
  }
}

export const goalApi = new GoalApi();
