import type { ApiError, WsFailure, WsRequest, WsSuccess } from './envelope';
import type { ScheduleDraftFields } from './schedule';

export type VoiceStreamStartPayload = {
  audio_format: 'pcm_s16le';
  sample_rate_hz: number;
  channels: number;
};

export type VoiceStreamStartCommand = WsRequest<'voice.stream.start', VoiceStreamStartPayload>;

export type VoiceStreamEndPayload = {
  stream_id: string;
};

export type VoiceStreamEndCommand = WsRequest<'voice.stream.end', VoiceStreamEndPayload>;

export type VoiceStreamError = WsFailure<'voice.stream.error'>;

export type VoiceStreamCancelPayload = {
  stream_id: string;
  job_id: string | null;
};

export type VoiceStreamCancelCommand = WsRequest<'voice.stream.cancel', VoiceStreamCancelPayload>;

export type VoiceStreamCancelAck =
  | WsSuccess<'voice.stream.cancelled', { stream_id: string }>
  | VoiceStreamError
  | WsFailure<'voice.stream.cancel'>;

export type VoiceStreamStarted = WsSuccess<
  'voice.stream.started',
  { stream_id: string; job_id: string }
>;

export type VoiceStreamEnded = WsSuccess<
  'voice.stream.ended',
  { stream_id: string; job_id: string; status: 'processing' }
>;

export type VoiceStreamStartResponse = VoiceStreamStarted | VoiceStreamError;
export type VoiceStreamEndResponse = VoiceStreamEnded | VoiceStreamError;

export type VoiceParseDraft = Omit<ScheduleDraftFields, 'geofence_armed'>;

export type VoiceParseReadyResult = {
  type: 'voice.parse.result';
  request_id: string;
  job_id: string;
  status: 'ready_for_confirmation';
  draft: VoiceParseDraft;
  missing_fields: string[];
  ambiguous_fields: string[];
  needs_confirmation: true;
};

export type VoiceParseFailedResult = {
  type: 'voice.parse.result';
  request_id: string;
  job_id: string;
  status: 'failed';
  error: ApiError;
};

export type VoiceParseResultMessage = VoiceParseReadyResult | VoiceParseFailedResult;
