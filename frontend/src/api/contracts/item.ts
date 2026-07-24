import type { ISODateTime, UUID } from './common';

export type ItemType = 'schedule' | 'todo' | 'subtask';
export type ItemStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled' | 'deferred';

/** 时间顺序 Tab 展示的日程、待办或长期目标子任务。 */
export interface TaskItem {
  id: UUID;
  user_id: UUID;
  long_goal_id?: UUID | null;
  item_type: ItemType;
  title: string;
  description?: string | null;
  start_at?: ISODateTime | null;
  end_at?: ISODateTime | null;
  due_at?: ISODateTime | null;
  status: ItemStatus;
  version: number;
}

/** 查询时间顺序事项；时间范围由前端显式传入。 */
export interface TimelineItemsRequest {
  user_id: UUID;
  start_at: ISODateTime;
  end_at: ISODateTime;
  item_type?: ItemType;
}

/** `GET /items/timeline` 的完整响应。 */
export interface TimelineItemsResult {
  items: TaskItem[];
}
