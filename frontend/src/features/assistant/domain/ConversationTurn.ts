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
  | { phase: 'error'; message: string };

export interface AppliedCommand {
  operation: string;
  status: string;
  schedule?: Record<string, unknown>;
  schedules?: Record<string, unknown>[];
}
