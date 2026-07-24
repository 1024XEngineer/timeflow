import type { ISODateTime, JsonObject, JsonValue, UUID } from './common';
import type { WriteDecision, WriteRequestStatus } from './writeRequest';

export type InputModality = 'text' | 'image' | 'audio';
export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool';
export type AgentName =
  | 'schedule_todo_agent'
  | 'feedback_agent'
  | 'replan_agent'
  | 'review_agent'
  | 'long_task_split_agent';
export type MessageKind =
  | 'input'
  | 'clarification_question'
  | 'clarification_answer'
  | 'decision'
  | 'execution_processing'
  | 'selection_required'
  | 'selection_submit'
  | 'selection_cancel'
  | 'execution_result'
  | 'confirmation_request'
  | 'confirmation_decision'
  | 'system_notice'
  | 'error';

/** 母 AI 解析或推导出的时间范围。 */
export interface TimeRange {
  start_at: ISODateTime;
  end_at: ISODateTime;
  source: 'user_explicit' | 'agent_inferred' | 'system_default';
}

/** 对话消息 metadata 的最新版结构。 */
export interface ConversationMessageMetadata {
  schema_version: number;
  message_kind: MessageKind;
  client_message_id?: string | null;
  trace_id?: string | null;
  question_id?: UUID | null;
  question_status?: 'open' | 'answered' | 'expired' | null;
  question_type?: 'normal' | 'long_task_split' | 'disambiguation' | 'confirmation' | null;
  expires_at?: ISODateTime | null;
  reply_to_question_id?: UUID | null;
  target_agent_name?: AgentName | null;
  target_function_name?: string | null;
  missing_fields?: string[];
  parsed_params?: JsonObject;
  time_range?: TimeRange | null;
  write_request_id?: UUID | null;
  decision?: WriteDecision | null;
}

/** 聊天历史、快照和 WS 恢复共同使用的消息 DTO。 */
export interface ConversationMessage {
  id: UUID;
  user_id: UUID;
  message_index: number;
  role: ConversationRole;
  modality: InputModality | null;
  raw_content: string;
  source_url: string | null;
  metadata: ConversationMessageMetadata;
  created_at: ISODateTime;
}

/** 文本输入使用 JSON 提交，raw_content 必填。 */
export interface TextConversationInputRequest {
  client_message_id: string;
  modality: 'text';
  raw_content: string;
  reply_to_question_id?: string;
}

/** 图片或音频输入使用 multipart/form-data 提交。 */
export interface MediaConversationInputRequest {
  client_message_id: string;
  modality: 'image' | 'audio';
  file: Blob;
  file_name: string;
  reply_to_question_id?: string;
}

/** 统一输入被 HTTP 接收后的结果；后续处理结果通过 WS 推送。 */
export interface ConversationInputAccepted {
  source_message_id: UUID;
  client_message_id: string;
  source_url?: string | null;
  status: 'accepted';
}

/** 向前翻页查询对话历史。 */
export interface ConversationMessagesRequest {
  user_id: UUID;
  before_message_id?: UUID;
  limit?: number;
}

/** 会话历史分页结果。最新版不再返回 next_cursor。 */
export interface ConversationMessagesResult {
  messages: ConversationMessage[];
  has_more: boolean;
}

/** 页面首次打开或刷新时恢复持久化可见状态。 */
export interface ConversationSnapshotRequest {
  user_id: UUID;
  last_seen_message_id?: UUID;
}

/** 反问问题中的单个选项；Wiki 只约束为字符串键值对象。 */
export type ClarificationOption = Record<string, string>;

/** 母 AI 请求用户补充的一个问题。 */
export interface ClarificationQuestion {
  question_id: string;
  field_name: string;
  question_text: string;
  options: ClarificationOption[];
}

/** 页面或 WS 恢复时可重新展示的待回答反问。 */
export interface ClarificationRequest {
  reason:
    | 'missing_required_params'
    | 'invalid_answer'
    | 'long_task_split_questions'
    | 'ambiguous_reference';
  mode: 'single' | 'batch';
  questions: ClarificationQuestion[];
  original_agent_name: AgentName | null;
  original_function_name: string | null;
}

/** 页面初始化使用的静态会话快照。 */
export interface ConversationSnapshot {
  recent_messages: ConversationMessage[];
  pending_clarification: ClarificationRequest | null;
  last_event: JsonObject | null;
}

/** 最新版 WebSocket 统一信封：全部关联字段都必须位于 payload。 */
export interface WsEnvelope<TType extends string, TPayload> {
  type: TType;
  timestamp: ISODateTime;
  payload: TPayload;
}

export interface DialogueClarificationPayload {
  source_message_id: UUID;
  questions: ClarificationQuestion[];
  reason: ClarificationRequest['reason'];
  mode: ClarificationRequest['mode'];
}

export interface DialogueDecisionPayload {
  source_message_id: UUID;
  target_agent_name: AgentName;
  target_function_name: string;
  parsed_params: JsonObject;
  time_range: TimeRange;
}

export interface ExecutionProcessingPayload {
  source_message_id: UUID;
  stage: string;
}

export interface SelectionRequiredPayload {
  interaction_id: string;
  candidate_items: JsonObject[];
  question_text: string;
}

export interface WriteConfirmationRequiredPayload {
  write_request_id: UUID;
  confirmation_payload: JsonObject;
}

export interface WriteAppliedPayload {
  write_request_id: UUID;
  status: WriteRequestStatus;
  applied_target_id?: UUID | null;
}

export interface ExecutionResultPayload {
  source_message_id: UUID;
  result: JsonValue;
}

export interface ConversationErrorPayload {
  source_message_id?: UUID | null;
  error_code: string;
  message: string;
}

export interface TransportSnapshotPayload {
  recent_messages: ConversationMessage[];
  pending_clarification: ClarificationRequest | null;
  last_event: JsonObject | null;
}

/** 服务端可推送给前端的全部最新版 WS 事件。 */
export type ConversationServerEvent =
  | WsEnvelope<'dialogue.clarification', DialogueClarificationPayload>
  | WsEnvelope<'dialogue.decision', DialogueDecisionPayload>
  | WsEnvelope<'execution.processing', ExecutionProcessingPayload>
  | WsEnvelope<'selection.required', SelectionRequiredPayload>
  | WsEnvelope<'write.confirmation_required', WriteConfirmationRequiredPayload>
  | WsEnvelope<'write.applied', WriteAppliedPayload>
  | WsEnvelope<'execution.result', ExecutionResultPayload>
  | WsEnvelope<'dialogue.error', ConversationErrorPayload>
  | WsEnvelope<'execution.error', ConversationErrorPayload>
  | WsEnvelope<'transport.ping', Record<string, never>>
  | WsEnvelope<'transport.pong', Record<string, never>>
  | WsEnvelope<'transport.snapshot', TransportSnapshotPayload>;

/** 用户提交候选选择。 */
export type SelectionSubmitEvent = WsEnvelope<
  'selection.submit',
  { interaction_id: string; selected_candidate_ids: string[] }
>;
/** 用户取消当前候选选择。 */
export type SelectionCancelEvent = WsEnvelope<'selection.cancel', { interaction_id: string }>;
/** 用户确认或拒绝待写入请求。 */
export type WriteDecideEvent = WsEnvelope<
  'write.decide',
  { write_request_id: UUID; decision: WriteDecision; idempotency_key: string }
>;
/** WebSocket 心跳控制事件。 */
export type TransportPingEvent = WsEnvelope<'transport.ping', Record<string, never>>;
export type TransportPongEvent = WsEnvelope<'transport.pong', Record<string, never>>;
/** 断线重连后请求补发遗漏的流式事件。 */
export type TransportResumeEvent = WsEnvelope<'transport.resume', { last_seen_message_id: UUID }>;

/** 前端可发送给服务端的全部最新版 WS 控制事件。 */
export type ConversationClientEvent =
  | SelectionSubmitEvent
  | SelectionCancelEvent
  | WriteDecideEvent
  | TransportPingEvent
  | TransportPongEvent
  | TransportResumeEvent;
