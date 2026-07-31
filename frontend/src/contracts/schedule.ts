import type { ApiError, WsFailure, WsRequest, WsSuccess } from './envelope';

export type ScheduleSourceMode = 'manual' | 'voice';
export type ScheduleType = 'time' | 'location';
export type ScheduleStatus = 'scheduled' | 'done' | 'deleted';

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

/** 草稿业务字段（创建/语音解析共用，不含 schedule_id / source_mode）。 */
export type ScheduleDraftFields = {
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

export type ScheduleUpsertPayload = ScheduleDraftFields & {
  schedule_id?: string | null;
  source_mode: ScheduleSourceMode;
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

/** 完成 / 恢复为已安排；与删除语义分离。 */
export type ScheduleStatusUpdatePayload = {
  schedule_id: string;
  status: Extract<ScheduleStatus, 'scheduled' | 'done'>;
};

export type ScheduleStatusUpdateCommand = WsRequest<
  'schedule.status.command',
  ScheduleStatusUpdatePayload
>;

export type ScheduleStatusUpdateResultPayload = {
  schedule_id: string;
  status: ScheduleStatus;
};

export type ScheduleStatusUpdateResult = WsSuccess<
  'schedule.status.result',
  ScheduleStatusUpdateResultPayload
>;

export type ScheduleStatusUpdateError = WsFailure<'schedule.status.error'>;
export type ScheduleStatusUpdateResponse = ScheduleStatusUpdateResult | ScheduleStatusUpdateError;

/** 客户端确认删除后，通知服务端取消监听与提醒（仅删除，不含完成）。 */
export type ScheduleDeleted = {
  type: 'schedule.deleted';
  request_id: string;
  schedule_id: string;
  deleted: true;
  timestamp: string;
};

export type ScheduleDeletedAck =
  | { type: 'schedule.deleted.ack'; request_id?: string; schedule_id: string; ok: true }
  | {
      type: 'schedule.deleted.ack';
      request_id?: string;
      schedule_id: string;
      ok: false;
      error: ApiError;
    };
