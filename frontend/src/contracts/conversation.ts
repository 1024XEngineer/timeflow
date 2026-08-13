/**
 * 语音助手 WS 消息契约，与后端 `gateway/websocket/messages/*.py` 逐字段对齐。
 * 协议要点见 AGENTS.md 第 6 节：一次转正流程是
 * session.hello → session.ready → voice.stream.start → [Binary PCM] →
 * voice.stream.end → voice.asr.completed → voice.command.result（或先
 * voice.dialogue.question 再补一轮）→ message.ack，TTS 走独立的
 * voice.tts.start → [Binary] → voice.tts.end 旁路。
 */

import type { OutgoingEnvelope, TransportErrorEnvelope } from './transport';

/* ---------- 客户端 → 服务端 ---------- */

export interface SessionHelloPayload {
  access_token: string;
  device_id: string;
  app_version?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}
export type SessionHelloMessage = OutgoingEnvelope<'session.hello', SessionHelloPayload>;

export interface VoiceStreamStartPayload {
  conversation_id?: string;
  audio_format: string;
  sample_rate_hz: number;
  channels: number;
}
export type VoiceStreamStartMessage = OutgoingEnvelope<
  'voice.stream.start',
  VoiceStreamStartPayload
>;

export interface VoiceStreamEndPayload {
  stream_id: string;
}
export type VoiceStreamEndMessage = OutgoingEnvelope<'voice.stream.end', VoiceStreamEndPayload>;

export interface MessageAckPayload {
  message_id: string;
  status: string;
}
/** message.ack 没有 payload 包装，字段直接挂在信封上，故意不复用 OutgoingEnvelope。 */
export interface MessageAckMessage {
  type: 'message.ack';
  message_id: string;
  status: string;
}

export type AssistantClientMessage =
  SessionHelloMessage | VoiceStreamStartMessage | VoiceStreamEndMessage | MessageAckMessage;

/* ---------- 服务端 → 客户端 ---------- */

export interface SessionReadyMessage {
  type: 'session.ready';
  request_id?: string;
  ok: true;
  payload: { session_id: string; server_time: string };
}

export interface VoiceStreamStartedMessage {
  type: 'voice.stream.started';
  request_id?: string;
  ok: true;
  payload: { stream_id: string; conversation_id: string };
}

export interface VoiceAsrCompletedMessage {
  type: 'voice.asr.completed';
  request_id?: string;
  conversation_id: string;
  payload: { transcript: string; language: string; duration_ms: number };
}

/** 日程快照的形状由后端 `ScheduleSnapshot` 决定；前端只透传给本地落库，不在此处强约束字段。 */
export type ScheduleSnapshotPayload = Record<string, unknown>;

export interface VoiceCommandResultMessage {
  type: 'voice.command.result';
  message_id: string;
  request_id?: string;
  conversation_id: string;
  payload: {
    operation: string;
    status: string;
    schedule?: ScheduleSnapshotPayload;
    schedules?: ScheduleSnapshotPayload[];
  };
}

export type QuestionKind =
  'missing_field' | 'ambiguous_target' | 'recurrence_scope' | 'confirmation';

export interface VoiceDialogueQuestionMessage {
  type: 'voice.dialogue.question';
  request_id?: string;
  conversation_id: string;
  payload: {
    question_id: string;
    question_kind: QuestionKind;
    speech_text: string;
    required_response?: string;
    candidates: Record<string, unknown>[];
  };
}

export interface VoiceDialogueReplyMessage {
  type: 'voice.dialogue.reply';
  request_id?: string;
  conversation_id: string;
  payload: { reply_id: string; speech_text: string; done: boolean };
}

export interface VoiceTtsStartMessage {
  type: 'voice.tts.start';
  conversation_id: string;
  audio_id: string;
  payload: {
    format: string;
    sample_rate_hz: number;
    purpose: string;
    speech_text: string;
    schedule_id?: string;
    audio_version?: number;
  };
}

export interface VoiceTtsEndMessage {
  type: 'voice.tts.end';
  conversation_id: string;
  audio_id: string;
}

export type AssistantServerMessage =
  | SessionReadyMessage
  | VoiceStreamStartedMessage
  | VoiceAsrCompletedMessage
  | VoiceCommandResultMessage
  | VoiceDialogueQuestionMessage
  | VoiceDialogueReplyMessage
  | VoiceTtsStartMessage
  | VoiceTtsEndMessage
  | TransportErrorEnvelope;

/** 窄化辅助：失败信封没有稳定的 `ok:false` 之外的判据，靠 `error` 字段是否存在区分。 */
export function isTransportError(
  message: AssistantServerMessage,
): message is TransportErrorEnvelope {
  return 'ok' in message && message.ok === false;
}
