import type { AuthSession, CurrentUser, LoginRequest, RegisterRequest } from './auth';
import type {
  AgentName,
  ClarificationQuestion,
  ClarificationRequest,
  ConversationClientEvent,
  ConversationErrorPayload,
  ConversationInputAccepted,
  ConversationMessage,
  ConversationMessageMetadata,
  ConversationMessagesRequest,
  ConversationMessagesResult,
  ConversationServerEvent,
  ConversationSnapshot,
  ConversationSnapshotRequest,
  MediaConversationInputRequest,
  TextConversationInputRequest,
  TimeRange,
  TransportSnapshotPayload,
} from './conversation';
import type {
  LongGoal,
  LongGoalDetailRequest,
  LongGoalDetailResult,
  LongGoalListRequest,
  LongGoalListResult,
  TaskProfileSnapshot,
} from './goal';
import type { TaskItem, TimelineItemsRequest, TimelineItemsResult } from './item';
import type { UserProfile, UserProfileRequest } from './profile';
import type {
  CreateWriteRequest,
  CreateWriteRequestResult,
  DecideWriteRequest,
  WriteDecisionResult,
} from './writeRequest';
import {
  ContractValidationError,
  parseArray,
  parseBoolean,
  parseEnum,
  parseInteger,
  parseIsoDateTime,
  parseJsonObject,
  parseJsonValue,
  parseNonEmptyString,
  parseNullable,
  parseObject,
  parseString,
  parseUuid,
} from '../core/validation';

/**
 * 运行时校验以 2026-07-24 Wiki 的
 * `Architecture interface design(draft)` 最新提交为唯一基线。
 *
 * 文档已冻结的 DTO 使用严格字段白名单；`UserProfileDTO`、
 * `confirmation_payload` 等未展开结构只校验为 JSON 对象。
 */
const INPUT_MODALITIES = ['text', 'image', 'audio'] as const;
const ROLES = ['user', 'assistant', 'system', 'tool'] as const;
const AGENT_NAMES = [
  'schedule_todo_agent',
  'feedback_agent',
  'replan_agent',
  'review_agent',
  'long_task_split_agent',
] as const;
const MESSAGE_KINDS = [
  'input',
  'clarification_question',
  'clarification_answer',
  'decision',
  'execution_processing',
  'selection_required',
  'selection_submit',
  'selection_cancel',
  'execution_result',
  'confirmation_request',
  'confirmation_decision',
  'system_notice',
  'error',
] as const;
const QUESTION_STATUSES = ['open', 'answered', 'expired'] as const;
const QUESTION_TYPES = ['normal', 'long_task_split', 'disambiguation', 'confirmation'] as const;
const TIME_RANGE_SOURCES = ['user_explicit', 'agent_inferred', 'system_default'] as const;
const ITEM_TYPES = ['schedule', 'todo', 'subtask'] as const;
const ITEM_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled', 'deferred'] as const;
const LONG_GOAL_STATUSES = ['active', 'completed', 'cancelled'] as const;
const CLARIFICATION_REASONS = [
  'missing_required_params',
  'invalid_answer',
  'long_task_split_questions',
  'ambiguous_reference',
] as const;
const CLARIFICATION_MODES = ['single', 'batch'] as const;
const WRITE_DECISIONS = ['confirmed', 'rejected'] as const;
const WRITE_ACTIONS = ['create', 'update', 'delete', 'feedback', 'replan', 'goal_split'] as const;
const WRITE_TARGET_TYPES = ['task_item', 'long_goal', 'feedback', 'profile'] as const;
const WRITE_REQUEST_STATUSES = ['confirmed', 'rejected', 'applied', 'expired'] as const;
const CLIENT_EVENT_TYPES = [
  'selection.submit',
  'selection.cancel',
  'write.decide',
  'transport.ping',
  'transport.pong',
  'transport.resume',
] as const;
const SERVER_EVENT_TYPES = [
  'dialogue.clarification',
  'dialogue.decision',
  'execution.processing',
  'selection.required',
  'write.confirmation_required',
  'write.applied',
  'execution.result',
  'dialogue.error',
  'execution.error',
  'transport.ping',
  'transport.pong',
  'transport.snapshot',
] as const;

function parseOptional<T>(
  value: unknown,
  path: string,
  parser: (value: unknown, path: string) => T,
): T | undefined {
  return value === undefined ? undefined : parser(value, path);
}

function parseOptionalNullable<T>(
  value: unknown,
  path: string,
  parser: (value: unknown, path: string) => T,
): T | null | undefined {
  return value === undefined ? undefined : parseNullable(value, path, parser);
}

function parseStringArray(value: unknown, path: string): string[] {
  return parseArray(value, path, parseString);
}

function parsePositiveInteger(value: unknown, path: string): number {
  const parsed = parseInteger(value, path);
  if (parsed < 1) {
    throw new ContractValidationError(path, '必须是正整数');
  }
  return parsed;
}

function parseBlob(value: unknown, path: string): Blob {
  if (!(value instanceof Blob)) {
    throw new ContractValidationError(path, '必须是 Blob 文件');
  }
  return value;
}

function parseEmptyObject(value: unknown, path: string): Record<string, never> {
  parseObject(value, path, []);
  return {};
}

function stripUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function parseTimeRange(value: unknown, path: string): TimeRange {
  const object = parseObject(value, path, ['start_at', 'end_at', 'source']);
  return {
    start_at: parseIsoDateTime(object.start_at, `${path}.start_at`),
    end_at: parseIsoDateTime(object.end_at, `${path}.end_at`),
    source: parseEnum(object.source, `${path}.source`, TIME_RANGE_SOURCES),
  };
}

function parseClarificationOption(value: unknown, path: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractValidationError(path, '必须是字符串键值对象');
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = parseString(item, `${path}.${key}`);
  }
  return result;
}

function parseClarificationQuestion(value: unknown, path: string): ClarificationQuestion {
  const object = parseObject(value, path, [
    'question_id',
    'field_name',
    'question_text',
    'options',
  ]);
  return {
    question_id: parseNonEmptyString(object.question_id, `${path}.question_id`),
    field_name: parseNonEmptyString(object.field_name, `${path}.field_name`),
    question_text: parseNonEmptyString(object.question_text, `${path}.question_text`),
    options: parseArray(object.options, `${path}.options`, parseClarificationOption),
  };
}

function parseClarificationRequest(value: unknown, path: string): ClarificationRequest {
  const object = parseObject(value, path, [
    'reason',
    'mode',
    'questions',
    'original_agent_name',
    'original_function_name',
  ]);
  return {
    reason: parseEnum(object.reason, `${path}.reason`, CLARIFICATION_REASONS),
    mode: parseEnum(object.mode, `${path}.mode`, CLARIFICATION_MODES),
    questions: parseArray(object.questions, `${path}.questions`, parseClarificationQuestion),
    original_agent_name: parseNullable(
      object.original_agent_name,
      `${path}.original_agent_name`,
      (item, itemPath) => parseEnum(item, itemPath, AGENT_NAMES),
    ),
    original_function_name: parseNullable(
      object.original_function_name,
      `${path}.original_function_name`,
      parseString,
    ),
  };
}

function parseConversationMessageMetadata(
  value: unknown,
  path: string,
): ConversationMessageMetadata {
  const optionalKeys = [
    'client_message_id',
    'trace_id',
    'question_id',
    'question_status',
    'question_type',
    'expires_at',
    'reply_to_question_id',
    'target_agent_name',
    'target_function_name',
    'missing_fields',
    'parsed_params',
    'time_range',
    'write_request_id',
    'decision',
  ] as const;
  const object = parseObject(value, path, ['schema_version', 'message_kind'], optionalKeys);
  const result: ConversationMessageMetadata = {
    schema_version: parseInteger(object.schema_version, `${path}.schema_version`),
    message_kind: parseEnum(object.message_kind, `${path}.message_kind`, MESSAGE_KINDS),
    client_message_id: parseOptionalNullable(
      object.client_message_id,
      `${path}.client_message_id`,
      parseString,
    ),
    trace_id: parseOptionalNullable(object.trace_id, `${path}.trace_id`, parseString),
    question_id: parseOptionalNullable(object.question_id, `${path}.question_id`, parseUuid),
    question_status: parseOptionalNullable(
      object.question_status,
      `${path}.question_status`,
      (item, itemPath) => parseEnum(item, itemPath, QUESTION_STATUSES),
    ),
    question_type: parseOptionalNullable(
      object.question_type,
      `${path}.question_type`,
      (item, itemPath) => parseEnum(item, itemPath, QUESTION_TYPES),
    ),
    expires_at: parseOptionalNullable(object.expires_at, `${path}.expires_at`, parseIsoDateTime),
    reply_to_question_id: parseOptionalNullable(
      object.reply_to_question_id,
      `${path}.reply_to_question_id`,
      parseUuid,
    ),
    target_agent_name: parseOptionalNullable(
      object.target_agent_name,
      `${path}.target_agent_name`,
      (item, itemPath) => parseEnum(item, itemPath, AGENT_NAMES),
    ),
    target_function_name: parseOptionalNullable(
      object.target_function_name,
      `${path}.target_function_name`,
      parseString,
    ),
    missing_fields: parseOptional(
      object.missing_fields,
      `${path}.missing_fields`,
      parseStringArray,
    ),
    parsed_params: parseOptional(object.parsed_params, `${path}.parsed_params`, parseJsonObject),
    time_range: parseOptionalNullable(object.time_range, `${path}.time_range`, parseTimeRange),
    write_request_id: parseOptionalNullable(
      object.write_request_id,
      `${path}.write_request_id`,
      parseUuid,
    ),
    decision: parseOptionalNullable(object.decision, `${path}.decision`, (item, itemPath) =>
      parseEnum(item, itemPath, WRITE_DECISIONS),
    ),
  };
  // 保持服务端原始字段集合：可选字段未返回时，不在解析结果中补 undefined。
  for (const key of Object.keys(result) as (keyof ConversationMessageMetadata)[]) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return result;
}

/** 注册请求发送前校验，拒绝缺字段和 Wiki 未声明字段。 */
export function parseRegisterRequest(value: unknown, path = 'request'): RegisterRequest {
  const object = parseObject(value, path, ['email', 'password', 'display_name']);
  return {
    email: parseNonEmptyString(object.email, `${path}.email`),
    password: parseNonEmptyString(object.password, `${path}.password`),
    display_name: parseString(object.display_name, `${path}.display_name`),
  };
}

/** 登录请求发送前校验。 */
export function parseLoginRequest(value: unknown, path = 'request'): LoginRequest {
  const object = parseObject(value, path, ['email', 'password']);
  return {
    email: parseNonEmptyString(object.email, `${path}.email`),
    password: parseNonEmptyString(object.password, `${path}.password`),
  };
}

/** 文本输入请求发送前校验，确保 raw_content 与 text 模态同时存在。 */
export function parseTextConversationInputRequest(
  value: unknown,
  path = 'request',
): TextConversationInputRequest {
  const object = parseObject(
    value,
    path,
    ['client_message_id', 'modality', 'raw_content'],
    ['reply_to_question_id'],
  );
  return stripUndefined({
    client_message_id: parseNonEmptyString(object.client_message_id, `${path}.client_message_id`),
    modality: parseEnum(object.modality, `${path}.modality`, ['text'] as const),
    raw_content: parseNonEmptyString(object.raw_content, `${path}.raw_content`),
    reply_to_question_id: parseOptional(
      object.reply_to_question_id,
      `${path}.reply_to_question_id`,
      parseNonEmptyString,
    ),
  });
}

/** 图片或音频请求发送前校验；file_name 仅供 FormData 文件名使用。 */
export function parseMediaConversationInputRequest(
  value: unknown,
  path = 'request',
): MediaConversationInputRequest {
  const object = parseObject(
    value,
    path,
    ['client_message_id', 'modality', 'file', 'file_name'],
    ['reply_to_question_id'],
  );
  return stripUndefined({
    client_message_id: parseNonEmptyString(object.client_message_id, `${path}.client_message_id`),
    modality: parseEnum(object.modality, `${path}.modality`, ['image', 'audio'] as const),
    file: parseBlob(object.file, `${path}.file`),
    file_name: parseNonEmptyString(object.file_name, `${path}.file_name`),
    reply_to_question_id: parseOptional(
      object.reply_to_question_id,
      `${path}.reply_to_question_id`,
      parseNonEmptyString,
    ),
  });
}

/** 会话历史查询参数发送前校验。 */
export function parseConversationMessagesRequest(
  value: unknown,
  path = 'request',
): ConversationMessagesRequest {
  const object = parseObject(value, path, ['user_id'], ['before_message_id', 'limit']);
  return stripUndefined({
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    before_message_id: parseOptional(
      object.before_message_id,
      `${path}.before_message_id`,
      parseUuid,
    ),
    limit: parseOptional(object.limit, `${path}.limit`, parsePositiveInteger),
  });
}

/** 页面静态快照查询参数发送前校验。 */
export function parseConversationSnapshotRequest(
  value: unknown,
  path = 'request',
): ConversationSnapshotRequest {
  const object = parseObject(value, path, ['user_id'], ['last_seen_message_id']);
  return stripUndefined({
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    last_seen_message_id: parseOptional(
      object.last_seen_message_id,
      `${path}.last_seen_message_id`,
      parseUuid,
    ),
  });
}

/** 时间线查询参数发送前校验。 */
export function parseTimelineItemsRequest(value: unknown, path = 'request'): TimelineItemsRequest {
  const object = parseObject(value, path, ['user_id', 'start_at', 'end_at'], ['item_type']);
  return stripUndefined({
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    start_at: parseIsoDateTime(object.start_at, `${path}.start_at`),
    end_at: parseIsoDateTime(object.end_at, `${path}.end_at`),
    item_type: parseOptional(object.item_type, `${path}.item_type`, (item, itemPath) =>
      parseEnum(item, itemPath, ITEM_TYPES),
    ),
  });
}

/** 长目标列表查询参数发送前校验。 */
export function parseLongGoalListRequest(value: unknown, path = 'request'): LongGoalListRequest {
  const object = parseObject(value, path, ['user_id'], ['status']);
  return stripUndefined({
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    status: parseOptional(object.status, `${path}.status`, (item, itemPath) =>
      parseEnum(item, itemPath, LONG_GOAL_STATUSES),
    ),
  });
}

/** 长目标详情查询参数发送前校验。 */
export function parseLongGoalDetailRequest(
  value: unknown,
  path = 'request',
): LongGoalDetailRequest {
  const object = parseObject(value, path, ['user_id']);
  return {
    user_id: parseUuid(object.user_id, `${path}.user_id`),
  };
}

/** 用户画像查询参数发送前校验。 */
export function parseUserProfileRequest(value: unknown, path = 'request'): UserProfileRequest {
  const object = parseObject(value, path, ['user_id']);
  return {
    user_id: parseUuid(object.user_id, `${path}.user_id`),
  };
}

/** 创建写入确认门禁的请求发送前校验。 */
export function parseCreateWriteRequest(value: unknown, path = 'request'): CreateWriteRequest {
  const object = parseObject(
    value,
    path,
    ['action', 'target_type', 'payload', 'preview_text'],
    ['target_id'],
  );
  return stripUndefined({
    action: parseEnum(object.action, `${path}.action`, WRITE_ACTIONS),
    target_type: parseEnum(object.target_type, `${path}.target_type`, WRITE_TARGET_TYPES),
    target_id: parseOptional(object.target_id, `${path}.target_id`, parseUuid),
    payload: parseJsonObject(object.payload, `${path}.payload`),
    preview_text: parseNonEmptyString(object.preview_text, `${path}.preview_text`),
  });
}

/** 确认或拒绝写入的请求发送前校验。 */
export function parseDecideWriteRequest(value: unknown, path = 'request'): DecideWriteRequest {
  const object = parseObject(value, path, ['decision', 'idempotency_key']);
  return {
    decision: parseEnum(object.decision, `${path}.decision`, WRITE_DECISIONS),
    idempotency_key: parseNonEmptyString(object.idempotency_key, `${path}.idempotency_key`),
  };
}

export function parseAuthSession(value: unknown, path = 'response'): AuthSession {
  const object = parseObject(value, path, ['user_id', 'business_user_id', 'access_token']);
  return {
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    business_user_id: parseNonEmptyString(object.business_user_id, `${path}.business_user_id`),
    access_token: parseNonEmptyString(object.access_token, `${path}.access_token`),
  };
}

export function parseCurrentUser(value: unknown, path = 'response'): CurrentUser {
  const object = parseObject(value, path, ['user_id', 'business_user_id', 'display_name']);
  return {
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    business_user_id: parseNonEmptyString(object.business_user_id, `${path}.business_user_id`),
    display_name: parseString(object.display_name, `${path}.display_name`),
  };
}

export function parseConversationInputAccepted(
  value: unknown,
  path = 'response',
): ConversationInputAccepted {
  const object = parseObject(
    value,
    path,
    ['source_message_id', 'client_message_id', 'status'],
    ['source_url'],
  );
  return stripUndefined({
    source_message_id: parseUuid(object.source_message_id, `${path}.source_message_id`),
    client_message_id: parseNonEmptyString(object.client_message_id, `${path}.client_message_id`),
    source_url: parseOptionalNullable(object.source_url, `${path}.source_url`, parseString),
    status: parseEnum(object.status, `${path}.status`, ['accepted'] as const),
  });
}

export function parseConversationMessage(
  value: unknown,
  path = 'response.messages[]',
): ConversationMessage {
  const object = parseObject(value, path, [
    'id',
    'user_id',
    'message_index',
    'role',
    'modality',
    'raw_content',
    'source_url',
    'metadata',
    'created_at',
  ]);
  return {
    id: parseUuid(object.id, `${path}.id`),
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    message_index: parseInteger(object.message_index, `${path}.message_index`),
    role: parseEnum(object.role, `${path}.role`, ROLES),
    modality: parseNullable(object.modality, `${path}.modality`, (item, itemPath) =>
      parseEnum(item, itemPath, INPUT_MODALITIES),
    ),
    raw_content: parseString(object.raw_content, `${path}.raw_content`),
    source_url: parseNullable(object.source_url, `${path}.source_url`, parseString),
    metadata: parseConversationMessageMetadata(object.metadata, `${path}.metadata`),
    created_at: parseIsoDateTime(object.created_at, `${path}.created_at`),
  };
}

export function parseConversationMessagesResult(
  value: unknown,
  path = 'response',
): ConversationMessagesResult {
  const object = parseObject(value, path, ['messages', 'has_more']);
  return {
    messages: parseArray(object.messages, `${path}.messages`, parseConversationMessage),
    has_more: parseBoolean(object.has_more, `${path}.has_more`),
  };
}

export function parseConversationSnapshot(value: unknown, path = 'response'): ConversationSnapshot {
  const object = parseObject(value, path, [
    'recent_messages',
    'pending_clarification',
    'last_event',
  ]);
  return {
    recent_messages: parseArray(
      object.recent_messages,
      `${path}.recent_messages`,
      parseConversationMessage,
    ),
    pending_clarification: parseNullable(
      object.pending_clarification,
      `${path}.pending_clarification`,
      parseClarificationRequest,
    ),
    last_event: parseNullable(object.last_event, `${path}.last_event`, parseJsonObject),
  };
}

export function parseTaskItem(value: unknown, path = 'response.items[]'): TaskItem {
  const object = parseObject(
    value,
    path,
    ['id', 'user_id', 'item_type', 'title', 'status', 'version'],
    ['long_goal_id', 'description', 'start_at', 'end_at', 'due_at'],
  );
  return stripUndefined({
    id: parseUuid(object.id, `${path}.id`),
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    long_goal_id: parseOptionalNullable(object.long_goal_id, `${path}.long_goal_id`, parseUuid),
    item_type: parseEnum(object.item_type, `${path}.item_type`, ITEM_TYPES),
    title: parseNonEmptyString(object.title, `${path}.title`),
    description: parseOptionalNullable(object.description, `${path}.description`, parseString),
    start_at: parseOptionalNullable(object.start_at, `${path}.start_at`, parseIsoDateTime),
    end_at: parseOptionalNullable(object.end_at, `${path}.end_at`, parseIsoDateTime),
    due_at: parseOptionalNullable(object.due_at, `${path}.due_at`, parseIsoDateTime),
    status: parseEnum(object.status, `${path}.status`, ITEM_STATUSES),
    version: parseInteger(object.version, `${path}.version`),
  });
}

export function parseTimelineItemsResult(value: unknown, path = 'response'): TimelineItemsResult {
  const object = parseObject(value, path, ['items']);
  return {
    items: parseArray(object.items, `${path}.items`, parseTaskItem),
  };
}

export function parseLongGoal(value: unknown, path = 'response.goals[]'): LongGoal {
  const object = parseObject(
    value,
    path,
    ['id', 'user_id', 'title', 'status', 'version'],
    ['description', 'plan_overview', 'start_at', 'deadline_at'],
  );
  return stripUndefined({
    id: parseUuid(object.id, `${path}.id`),
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    title: parseNonEmptyString(object.title, `${path}.title`),
    description: parseOptionalNullable(object.description, `${path}.description`, parseString),
    plan_overview: parseOptionalNullable(
      object.plan_overview,
      `${path}.plan_overview`,
      parseString,
    ),
    start_at: parseOptionalNullable(object.start_at, `${path}.start_at`, parseIsoDateTime),
    deadline_at: parseOptionalNullable(object.deadline_at, `${path}.deadline_at`, parseIsoDateTime),
    status: parseEnum(object.status, `${path}.status`, LONG_GOAL_STATUSES),
    version: parseInteger(object.version, `${path}.version`),
  });
}

export function parseLongGoalListResult(value: unknown, path = 'response'): LongGoalListResult {
  const object = parseObject(value, path, ['goals']);
  return {
    goals: parseArray(object.goals, `${path}.goals`, parseLongGoal),
  };
}

/** 校验长任务创建时固化的任务画像快照。 */
export function parseTaskProfileSnapshot(
  value: unknown,
  path = 'response.task_profile',
): TaskProfileSnapshot {
  const object = parseObject(value, path, [
    'id',
    'user_id',
    'long_goal_id',
    'profile_summary',
    'source_message_id',
    'version',
  ]);
  return {
    id: parseUuid(object.id, `${path}.id`),
    user_id: parseUuid(object.user_id, `${path}.user_id`),
    long_goal_id: parseUuid(object.long_goal_id, `${path}.long_goal_id`),
    profile_summary: parseNonEmptyString(object.profile_summary, `${path}.profile_summary`),
    source_message_id: parseUuid(object.source_message_id, `${path}.source_message_id`),
    version: parseInteger(object.version, `${path}.version`),
  };
}

export function parseLongGoalDetailResult(value: unknown, path = 'response'): LongGoalDetailResult {
  const object = parseObject(value, path, ['goal', 'subtasks', 'task_profile']);
  return {
    goal: parseLongGoal(object.goal, `${path}.goal`),
    subtasks: parseArray(object.subtasks, `${path}.subtasks`, parseTaskItem),
    task_profile: parseNullable(
      object.task_profile,
      `${path}.task_profile`,
      parseTaskProfileSnapshot,
    ),
  };
}

export function parseUserProfile(value: unknown, path = 'response'): UserProfile {
  return parseJsonObject(value, path);
}

export function parseCreateWriteRequestResult(
  value: unknown,
  path = 'response',
): CreateWriteRequestResult {
  const object = parseObject(value, path, [
    'write_request_id',
    'payload_hash',
    'confirmation_payload',
  ]);
  return {
    write_request_id: parseUuid(object.write_request_id, `${path}.write_request_id`),
    payload_hash: parseNonEmptyString(object.payload_hash, `${path}.payload_hash`),
    confirmation_payload: parseJsonObject(
      object.confirmation_payload,
      `${path}.confirmation_payload`,
    ),
  };
}

export function parseWriteDecisionResult(value: unknown, path = 'response'): WriteDecisionResult {
  const object = parseObject(
    value,
    path,
    ['write_request_id', 'status'],
    ['applied_target_id', 'message'],
  );
  return stripUndefined({
    write_request_id: parseUuid(object.write_request_id, `${path}.write_request_id`),
    status: parseEnum(object.status, `${path}.status`, WRITE_REQUEST_STATUSES),
    applied_target_id: parseOptionalNullable(
      object.applied_target_id,
      `${path}.applied_target_id`,
      parseUuid,
    ),
    message: parseOptionalNullable(object.message, `${path}.message`, parseString),
  });
}

function parseDialogueError(value: unknown, path: string): ConversationErrorPayload {
  const object = parseObject(value, path, ['error_code', 'message'], ['source_message_id']);
  return {
    source_message_id: parseOptionalNullable(
      object.source_message_id,
      `${path}.source_message_id`,
      parseUuid,
    ),
    error_code: parseNonEmptyString(object.error_code, `${path}.error_code`),
    message: parseNonEmptyString(object.message, `${path}.message`),
  };
}

function parseTransportSnapshot(value: unknown, path: string): TransportSnapshotPayload {
  return parseConversationSnapshot(value, path);
}

export function parseConversationServerEvent(
  value: unknown,
  path = 'event',
): ConversationServerEvent {
  const envelope = parseObject(value, path, ['type', 'timestamp', 'payload']);
  const type = parseEnum(envelope.type, `${path}.type`, SERVER_EVENT_TYPES);
  const timestamp = parseIsoDateTime(envelope.timestamp, `${path}.timestamp`);
  const payloadPath = `${path}.payload`;

  switch (type) {
    case 'dialogue.clarification': {
      const payload = parseObject(envelope.payload, payloadPath, [
        'source_message_id',
        'questions',
        'reason',
        'mode',
      ]);
      return {
        type,
        timestamp,
        payload: {
          source_message_id: parseUuid(
            payload.source_message_id,
            `${payloadPath}.source_message_id`,
          ),
          questions: parseArray(
            payload.questions,
            `${payloadPath}.questions`,
            parseClarificationQuestion,
          ),
          reason: parseEnum(payload.reason, `${payloadPath}.reason`, CLARIFICATION_REASONS),
          mode: parseEnum(payload.mode, `${payloadPath}.mode`, CLARIFICATION_MODES),
        },
      };
    }
    case 'dialogue.decision': {
      const payload = parseObject(envelope.payload, payloadPath, [
        'source_message_id',
        'target_agent_name',
        'target_function_name',
        'parsed_params',
        'time_range',
      ]);
      return {
        type,
        timestamp,
        payload: {
          source_message_id: parseUuid(
            payload.source_message_id,
            `${payloadPath}.source_message_id`,
          ),
          target_agent_name: parseEnum(
            payload.target_agent_name,
            `${payloadPath}.target_agent_name`,
            AGENT_NAMES,
          ) as AgentName,
          target_function_name: parseNonEmptyString(
            payload.target_function_name,
            `${payloadPath}.target_function_name`,
          ),
          parsed_params: parseJsonObject(payload.parsed_params, `${payloadPath}.parsed_params`),
          time_range: parseTimeRange(payload.time_range, `${payloadPath}.time_range`),
        },
      };
    }
    case 'execution.processing': {
      const payload = parseObject(envelope.payload, payloadPath, ['source_message_id', 'stage']);
      return {
        type,
        timestamp,
        payload: {
          source_message_id: parseUuid(
            payload.source_message_id,
            `${payloadPath}.source_message_id`,
          ),
          stage: parseNonEmptyString(payload.stage, `${payloadPath}.stage`),
        },
      };
    }
    case 'selection.required': {
      const payload = parseObject(envelope.payload, payloadPath, [
        'interaction_id',
        'candidate_items',
        'question_text',
      ]);
      return {
        type,
        timestamp,
        payload: {
          interaction_id: parseNonEmptyString(
            payload.interaction_id,
            `${payloadPath}.interaction_id`,
          ),
          candidate_items: parseArray(
            payload.candidate_items,
            `${payloadPath}.candidate_items`,
            parseJsonObject,
          ),
          question_text: parseNonEmptyString(payload.question_text, `${payloadPath}.question_text`),
        },
      };
    }
    case 'write.confirmation_required': {
      const payload = parseObject(envelope.payload, payloadPath, [
        'write_request_id',
        'confirmation_payload',
      ]);
      return {
        type,
        timestamp,
        payload: {
          write_request_id: parseUuid(payload.write_request_id, `${payloadPath}.write_request_id`),
          confirmation_payload: parseJsonObject(
            payload.confirmation_payload,
            `${payloadPath}.confirmation_payload`,
          ),
        },
      };
    }
    case 'write.applied': {
      const payload = parseObject(
        envelope.payload,
        payloadPath,
        ['write_request_id', 'status'],
        ['applied_target_id'],
      );
      return {
        type,
        timestamp,
        payload: {
          write_request_id: parseUuid(payload.write_request_id, `${payloadPath}.write_request_id`),
          status: parseEnum(payload.status, `${payloadPath}.status`, WRITE_REQUEST_STATUSES),
          applied_target_id: parseOptionalNullable(
            payload.applied_target_id,
            `${payloadPath}.applied_target_id`,
            parseUuid,
          ),
        },
      };
    }
    case 'execution.result': {
      const payload = parseObject(envelope.payload, payloadPath, ['source_message_id', 'result']);
      return {
        type,
        timestamp,
        payload: {
          source_message_id: parseUuid(
            payload.source_message_id,
            `${payloadPath}.source_message_id`,
          ),
          result: parseJsonValue(payload.result, `${payloadPath}.result`),
        },
      };
    }
    case 'dialogue.error':
    case 'execution.error':
      return { type, timestamp, payload: parseDialogueError(envelope.payload, payloadPath) };
    case 'transport.snapshot':
      return {
        type,
        timestamp,
        payload: parseTransportSnapshot(envelope.payload, payloadPath),
      };
    case 'transport.ping':
    case 'transport.pong':
      return { type, timestamp, payload: parseEmptyObject(envelope.payload, payloadPath) };
  }
}

export function parseConversationClientEvent(
  value: unknown,
  path = 'event',
): ConversationClientEvent {
  const envelope = parseObject(value, path, ['type', 'timestamp', 'payload']);
  const type = parseEnum(envelope.type, `${path}.type`, CLIENT_EVENT_TYPES);
  const timestamp = parseIsoDateTime(envelope.timestamp, `${path}.timestamp`);
  const payloadPath = `${path}.payload`;

  switch (type) {
    case 'selection.submit': {
      const payload = parseObject(envelope.payload, payloadPath, [
        'interaction_id',
        'selected_candidate_ids',
      ]);
      return {
        type,
        timestamp,
        payload: {
          interaction_id: parseNonEmptyString(
            payload.interaction_id,
            `${payloadPath}.interaction_id`,
          ),
          selected_candidate_ids: parseArray(
            payload.selected_candidate_ids,
            `${payloadPath}.selected_candidate_ids`,
            parseNonEmptyString,
          ),
        },
      };
    }
    case 'selection.cancel': {
      const payload = parseObject(envelope.payload, payloadPath, ['interaction_id']);
      return {
        type,
        timestamp,
        payload: {
          interaction_id: parseNonEmptyString(
            payload.interaction_id,
            `${payloadPath}.interaction_id`,
          ),
        },
      };
    }
    case 'write.decide': {
      const payload = parseObject(envelope.payload, payloadPath, [
        'write_request_id',
        'decision',
        'idempotency_key',
      ]);
      return {
        type,
        timestamp,
        payload: {
          write_request_id: parseUuid(payload.write_request_id, `${payloadPath}.write_request_id`),
          decision: parseEnum(payload.decision, `${payloadPath}.decision`, WRITE_DECISIONS),
          idempotency_key: parseNonEmptyString(
            payload.idempotency_key,
            `${payloadPath}.idempotency_key`,
          ),
        },
      };
    }
    case 'transport.resume': {
      const payload = parseObject(envelope.payload, payloadPath, ['last_seen_message_id']);
      return {
        type,
        timestamp,
        payload: {
          last_seen_message_id: parseUuid(
            payload.last_seen_message_id,
            `${payloadPath}.last_seen_message_id`,
          ),
        },
      };
    }
    case 'transport.ping':
    case 'transport.pong':
      return { type, timestamp, payload: parseEmptyObject(envelope.payload, payloadPath) };
  }
}
