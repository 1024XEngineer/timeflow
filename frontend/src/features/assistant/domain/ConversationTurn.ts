/**
 * 一轮语音交互的状态机。纯类型，不依赖 React/WS/录音 SDK，方便展示层和应用层
 * 各自按需渲染或编排，而不必读懂传输细节。
 */

export type ConversationTurnState =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | { phase: 'recording'; conversationId: string | null }
  | { phase: 'awaiting_result'; conversationId: string }
  | { phase: 'asking'; conversationId: string; speechText: string }
  | { phase: 'speaking'; conversationId: string }
  /** 连续模式专属：麦克风开着、待命中，既没在说话也没在播放回复。 */
  | { phase: 'listening'; conversationId: string | null }
  /** 连续模式专属：刚收到 voice.tts.canceled，用户的话打断了正在播的回复。 */
  | { phase: 'interrupted'; conversationId: string }
  /** 连续模式专属：用户点圆圈暂停，或切到后台自动暂停——麦克风仍开着但不推流。 */
  | { phase: 'paused'; conversationId: string | null }
  | { phase: 'error'; message: string };

export interface AppliedOccurrenceOverride {
  id: string;
  schedule_id: string;
  occurrence_start: string;
  action: 'cancel' | 'replace';
  replacement_schedule_id: string | null;
}

/** 免提长对话里一条已落屏的对白：用户来自 ASR，助手来自回复/追问。 */
export interface VoiceChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 流式还没收完时为 true，通话页用来画正在说的波形。 */
  pending?: boolean;
}

/** 连续对话历史里的一轮：一次用户发言 + 对应的系统回复（可能还没到）。 */
export interface ConversationTurnRecord {
  readonly id: string;
  readonly transcript: string;
  readonly replyText: string | null;
}

export interface AppliedCommand {
  operation: string;
  status: string;
  schedule?: Record<string, unknown>;
  schedules?: Record<string, unknown>[];
  occurrence_overrides?: AppliedOccurrenceOverride[];
}
