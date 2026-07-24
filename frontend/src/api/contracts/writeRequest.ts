import type { JsonObject, UUID } from './common';

export type WriteAction = 'create' | 'update' | 'delete' | 'feedback' | 'replan' | 'goal_split';
export type WriteTargetType = 'task_item' | 'long_goal' | 'feedback' | 'profile';
export type WriteDecision = 'confirmed' | 'rejected';
export type WriteRequestStatus = 'confirmed' | 'rejected' | 'applied' | 'expired';

/** 手动新增、修改或删除业务数据前创建统一确认门禁。 */
export interface CreateWriteRequest {
  action: WriteAction;
  target_type: WriteTargetType;
  target_id?: UUID;
  payload: JsonObject;
  preview_text: string;
}

/**
 * 创建写入请求后的确认信息。
 * confirmation_payload 的内部字段尚未在最新版 Wiki 中冻结。
 */
export interface CreateWriteRequestResult {
  write_request_id: UUID;
  payload_hash: string;
  confirmation_payload: JsonObject;
}

/** 用户确认或拒绝写入，幂等键防止重复提交。 */
export interface DecideWriteRequest {
  decision: WriteDecision;
  idempotency_key: string;
}

/** 写入确认决定的处理结果。 */
export interface WriteDecisionResult {
  write_request_id: UUID;
  status: WriteRequestStatus;
  applied_target_id?: UUID | null;
  message?: string | null;
}
