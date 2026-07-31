import type { ApiError } from './envelope';

/**
 * 提醒通道协议（预留）。
 * 当前前端尚未接入 WS 提醒控制 / TTS 音频流；类型仅作与后端对齐的权威契约文档。
 * 接入客户端前请勿在业务层依赖这些消息。
 */

/** 服务端下发提醒控制；具体展示通道由客户端根据前后台自行决定。 */
export type ReminderControl = {
  type: 'reminder.control';
  schedule_id: string;
  reason: string;
  action: 'show';
};

export type ReminderControlAck =
  | { type: 'reminder.control.ack'; schedule_id: string; ok: true }
  | { type: 'reminder.control.ack'; schedule_id: string; ok: false; error: ApiError };

/** 提醒 TTS 音频流开始；随后通过同一 WebSocket 连接发送 Binary Frame。 */
export type ReminderAudioStart = {
  type: 'reminder.audio.start';
  schedule_id: string;
  stream_id: string;
  audio_format: 'mp3';
};

export type ReminderAudioEnd = {
  type: 'reminder.audio.end';
  schedule_id: string;
  stream_id: string;
};

export type ReminderAudioAck =
  | {
      type: 'reminder.audio.ack';
      schedule_id: string;
      stream_id: string;
      ok: true;
    }
  | {
      type: 'reminder.audio.ack';
      schedule_id: string;
      stream_id: string;
      ok: false;
      error: ApiError;
    };
