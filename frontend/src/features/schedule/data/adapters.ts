import type {
  Schedule,
  ScheduleDraftFields,
  ScheduleUpsertCommand,
  ScheduleUpsertPayload,
  VoiceParseDraft,
} from '@/contracts';

type ScheduleDraft = ScheduleUpsertPayload;

/** 草稿业务字段归一化（`?? null`）；调用方再补 source_mode / 特有默认值。 */
function normalizeScheduleDraftFields(fields: ScheduleDraftFields) {
  return {
    schedule_type: fields.schedule_type,
    title: fields.title,
    notes: fields.notes ?? null,
    start_time: fields.start_time ?? null,
    end_time: fields.end_time ?? null,
    timezone: fields.timezone ?? null,
    location_name: fields.location_name ?? null,
    location_address: fields.location_address ?? null,
    latitude: fields.latitude ?? null,
    longitude: fields.longitude ?? null,
    geofence_radius_meters: fields.geofence_radius_meters ?? null,
    geofence_armed: fields.geofence_armed ?? null,
    time_remind_offset_minutes: fields.time_remind_offset_minutes ?? null,
  };
}

/** Schedule → wire upsert payload / 编辑回填草稿（同一份字段投影）。 */
function toUpsertPayload(schedule: Schedule): ScheduleUpsertPayload {
  return {
    schedule_id: schedule.id,
    source_mode: schedule.source_mode,
    schedule_type: schedule.schedule_type,
    title: schedule.title,
    notes: schedule.notes,
    start_time: schedule.start_time,
    end_time: schedule.end_time,
    timezone: schedule.timezone,
    location_name: schedule.location_name,
    location_address: schedule.location_address,
    latitude: schedule.latitude,
    longitude: schedule.longitude,
    geofence_radius_meters: schedule.geofence_radius_meters,
    geofence_armed: schedule.geofence_armed,
    time_remind_offset_minutes: schedule.time_remind_offset_minutes,
  };
}

export function upsertDraftForSchedule(schedule: Schedule): ScheduleDraft {
  return toUpsertPayload(schedule);
}

/** AppShell：将语音解析草稿映射为日程草稿。 */
export function scheduleDraftFromVoiceParse(draft: VoiceParseDraft): ScheduleDraft {
  return {
    source_mode: 'voice',
    ...normalizeScheduleDraftFields({
      ...draft,
      time_remind_offset_minutes: draft.time_remind_offset_minutes ?? 0,
    }),
  };
}

export function toUpsertCommand(draft: ScheduleDraft, requestId: string): ScheduleUpsertCommand {
  return {
    type: 'schedule.upsert.command',
    request_id: requestId,
    payload: draft,
  };
}

/** draft → Schedule 实体（保存时组装）。 */
export function scheduleFromUpsertPayload(input: {
  draft: ScheduleDraft;
  scheduleId: string;
  userId: string;
  status: Schedule['status'];
  geofenceArmed: boolean;
  existing?: Schedule | null;
  systemScheduleRefId?: string | null;
}): Schedule {
  const { draft, existing } = input;
  const fields = normalizeScheduleDraftFields(draft);
  const now = new Date().toISOString();
  return {
    id: input.scheduleId,
    user_id: existing?.user_id ?? input.userId,
    source_mode: draft.source_mode,
    schedule_type: fields.schedule_type,
    status: input.status,
    title: fields.title,
    notes: fields.notes,
    start_time: fields.start_time,
    end_time: fields.end_time,
    timezone: fields.timezone,
    location_name: fields.location_name,
    location_address: fields.location_address,
    latitude: fields.latitude,
    longitude: fields.longitude,
    geofence_radius_meters:
      fields.geofence_radius_meters ?? existing?.geofence_radius_meters ?? 100,
    geofence_armed: input.geofenceArmed,
    time_remind_offset_minutes: fields.time_remind_offset_minutes ?? 0,
    time_triggered_at: existing?.time_triggered_at ?? null,
    geo_triggered_at: existing?.geo_triggered_at ?? null,
    system_schedule_ref_id:
      input.systemScheduleRefId !== undefined
        ? input.systemScheduleRefId
        : (existing?.system_schedule_ref_id ?? null),
    system_alarm_ref_id: existing?.system_alarm_ref_id ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}
