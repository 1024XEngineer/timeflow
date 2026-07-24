import type { TimelineItemsRequest, TimelineItemsResult } from '../contracts/item';
import { parseTimelineItemsResult } from '../contracts/validators';
import { HttpClient, httpClient } from '../core/http';

/** 负责时间顺序 Tab 的只读事项查询。 */
export class ItemApi {
  constructor(private readonly http: HttpClient = httpClient) {}

  /**
   * 查询指定时间范围内的日程、待办和子任务。
   * 对应 `GET /api/v1/items/timeline`，不生成 AI 建议，也不修改事项。
   */
  getTimeline(request: TimelineItemsRequest): Promise<TimelineItemsResult> {
    return this.http.request<TimelineItemsResult>(
      '/items/timeline',
      {
        query: { ...request },
      },
      parseTimelineItemsResult,
    );
  }
}

export const itemApi = new ItemApi();
