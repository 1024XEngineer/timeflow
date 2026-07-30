export type Tab = 'today' | 'create' | 'me';
export type CalendarView = 'day' | 'week' | 'month';

export type ScheduleSourceMode = 'manual' | 'voice';
export type ScheduleType = 'time' | 'location';
export type ScheduleStatus = 'scheduled' | 'done' | 'deleted';

export type ApiError = {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
};

export type WsRequest<TType extends string, TPayload> = {
  type: TType;
  request_id: string;
  payload: TPayload;
};

export type WsSuccess<TType extends string, TPayload> = {
  type: TType;
  request_id: string;
  ok: true;
  payload: TPayload;
};

export type WsFailure<TType extends string> = {
  type: TType;
  request_id: string;
  ok: false;
  error: ApiError;
};

export type Schedule = {
  id: string;
  user_id: string;
  source_mode: ScheduleSourceMode;
  schedule_type: ScheduleType;
  status: ScheduleStatus;
  title: string;
  notes: string | null;
  start_time: string | null;
  end_time: string | null;
  timezone: string | null;
  location_name: string | null;
  location_address: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_meters: number;
  geofence_armed: boolean;
  time_remind_offset_minutes: number;
  time_triggered_at: string | null;
  geo_triggered_at: string | null;
  system_schedule_ref_id: string | null;
  system_alarm_ref_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduleListQueryPayload = {
  status: ScheduleStatus | null;
  include_deleted: boolean;
};

export type ScheduleListQuery = WsRequest<'schedule.list.query', ScheduleListQueryPayload>;

export type ScheduleListResultPayload = {
  schedules: Schedule[];
};

export type ScheduleListResult = WsSuccess<'schedule.list.result', ScheduleListResultPayload>;

export type ScheduleListError = WsFailure<'schedule.list.error'>;
export type ScheduleListResponse = ScheduleListResult | ScheduleListError;

export type ScheduleConflict = {
  schedule_id: string;
  title: string;
  start_time: string;
  end_time: string | null;
};

export type ScheduleUpsertPayload = {
  schedule_id?: string | null;
  source_mode: ScheduleSourceMode;
  schedule_type: ScheduleType;
  title: string;
  notes?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  timezone?: string | null;
  location_name?: string | null;
  location_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  geofence_radius_meters?: number | null;
  geofence_armed?: boolean | null;
  time_remind_offset_minutes?: number | null;
};

export type ScheduleUpsertCommand = WsRequest<'schedule.upsert.command', ScheduleUpsertPayload>;

export type ScheduleUpsertResultPayload = {
  schedule_id: string;
  schedule_type: ScheduleType;
  status: ScheduleStatus;
  conflicts: ScheduleConflict[];
  geofence_armed: boolean;
};

export type ScheduleUpsertResult = WsSuccess<'schedule.upsert.result', ScheduleUpsertResultPayload>;

export type ScheduleUpsertError = WsFailure<'schedule.upsert.error'>;
export type ScheduleUpsertResponse = ScheduleUpsertResult | ScheduleUpsertError;

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

export type VoiceStreamStarted = WsSuccess<
  'voice.stream.started',
  { stream_id: string; job_id: string }
>;

export type VoiceStreamEnded = WsSuccess<
  'voice.stream.ended',
  { stream_id: string; job_id: string; status: 'processing' }
>;

export type VoiceStreamError = WsFailure<'voice.stream.error'>;
export type VoiceStreamStartResponse = VoiceStreamStarted | VoiceStreamError;
export type VoiceStreamEndResponse = VoiceStreamEnded | VoiceStreamError;

export type VoiceParseDraft = {
  schedule_type: ScheduleType;
  title: string;
  notes?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  timezone?: string | null;
  location_name?: string | null;
  location_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  geofence_radius_meters?: number | null;
  time_remind_offset_minutes?: number | null;
};

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

export type SessionHello = {
  type: 'session.hello';
  device_id: string;
  app_version: string;
};

export type SessionReady = {
  type: 'session.ready';
  device_id: string;
  server_time: string;
};

export type SessionError = {
  type: 'session.error';
  ok: false;
  error: ApiError;
};

export type LocationReport = {
  type: 'location.report';
  schedule_scope: 'current';
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: string;
};

export type LocationReportAck =
  | { type: 'location.report.ack'; ok: true }
  | { type: 'location.report.ack'; ok: false; error: ApiError };
