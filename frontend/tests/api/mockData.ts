import type { AuthSession, CurrentUser } from '../../src/api/contracts/auth';
import type {
  ConversationInputAccepted,
  ConversationMessagesResult,
  ConversationSnapshot,
  ExecutionProcessingPayload,
  WsEnvelope,
  WriteConfirmationRequiredPayload,
} from '../../src/api/contracts/conversation';
import type { ISODateTime, UUID } from '../../src/api/contracts/common';
import type {
  LongGoal,
  LongGoalDetailResult,
  LongGoalListResult,
} from '../../src/api/contracts/goal';
import type { TaskItem, TimelineItemsResult } from '../../src/api/contracts/item';
import type {
  CreateWriteRequestResult,
  WriteDecisionResult,
} from '../../src/api/contracts/writeRequest';

export const mockTimestamp: ISODateTime = '2026-07-24T15:00:00+08:00';
export const mockUserId: UUID = '20a64e74-b213-44ad-b46b-16ca0805923c';
export const mockMessageId: UUID = '5d0e1fca-dc6e-4ff4-ab7a-a161e8245585';
export const mockGoalId: UUID = 'c10c593b-1a06-4950-8174-fe67bbee5d51';
export const mockWriteRequestId: UUID = '968a8659-d82c-4b43-a828-4a658cd28e93';

export const mockAuthSession: AuthSession = {
  user_id: mockUserId,
  business_user_id: 'TF000001',
  access_token: 'mock.jwt.token',
};

export const mockCurrentUser: CurrentUser = {
  user_id: mockUserId,
  business_user_id: 'TF000001',
  display_name: '浩涛',
};

export const mockInputAccepted: ConversationInputAccepted = {
  source_message_id: mockMessageId,
  client_message_id: 'client-message-01',
  source_url: null,
  status: 'accepted',
};

export const mockConversationMessages: ConversationMessagesResult = {
  messages: [
    {
      id: mockMessageId,
      user_id: mockUserId,
      message_index: 1,
      role: 'user',
      modality: 'text',
      raw_content: '明天下午三点开项目会议',
      source_url: null,
      metadata: {
        schema_version: 1,
        message_kind: 'input',
        client_message_id: 'client-message-01',
        trace_id: 'trace-01',
        missing_fields: [],
        parsed_params: {},
        time_range: null,
      },
      created_at: mockTimestamp,
    },
  ],
  has_more: false,
};

export const mockSnapshot: ConversationSnapshot = {
  recent_messages: mockConversationMessages.messages,
  pending_clarification: null,
  last_event: {
    type: 'execution.processing',
  },
};

export const mockTaskItem: TaskItem = {
  id: '3dd63c85-172a-4baa-a962-9a2c423e9ac1',
  user_id: mockUserId,
  long_goal_id: mockGoalId,
  item_type: 'schedule',
  title: '项目会议',
  description: '确认 MVP 接口',
  start_at: '2026-07-24T15:00:00+08:00',
  end_at: '2026-07-24T16:00:00+08:00',
  due_at: null,
  status: 'planned',
  version: 3,
};

export const mockTimeline: TimelineItemsResult = {
  items: [mockTaskItem],
};

export const mockLongGoal: LongGoal = {
  id: mockGoalId,
  user_id: mockUserId,
  title: '完成 TimeFlow MVP',
  description: '完成可演示闭环',
  plan_overview: '先完成接口，再联调页面',
  start_at: '2026-07-20T09:00:00+08:00',
  deadline_at: '2026-08-01T18:00:00+08:00',
  status: 'active',
  version: 2,
};

export const mockLongGoalList: LongGoalListResult = {
  goals: [mockLongGoal],
};

export const mockLongGoalDetail: LongGoalDetailResult = {
  goal: mockLongGoal,
  subtasks: [mockTaskItem],
  task_profile: {
    profile_summary: '偏好上午处理高专注任务',
  },
};

export const mockUserProfile = {
  preferred_work_periods: ['morning'],
  default_task_duration_minutes: 45,
};

export const mockCreateWriteRequestResult: CreateWriteRequestResult = {
  write_request_id: mockWriteRequestId,
  payload_hash: 'mock-sha256',
  confirmation_payload: {
    title: '创建日程',
    preview_text: '明天下午三点开项目会议',
  },
};

export const mockWriteDecisionResult: WriteDecisionResult = {
  write_request_id: mockWriteRequestId,
  status: 'applied',
  applied_target_id: mockTaskItem.id,
  message: '日程已创建',
};

export const mockProcessingEvent: WsEnvelope<'execution.processing', ExecutionProcessingPayload> = {
  type: 'execution.processing',
  timestamp: mockTimestamp,
  payload: {
    source_message_id: mockMessageId,
    stage: 'calling_sub_agent',
  },
};

export const mockConfirmationEvent: WsEnvelope<
  'write.confirmation_required',
  WriteConfirmationRequiredPayload
> = {
  type: 'write.confirmation_required',
  timestamp: mockTimestamp,
  payload: {
    write_request_id: mockWriteRequestId,
    confirmation_payload: mockCreateWriteRequestResult.confirmation_payload,
  },
};
