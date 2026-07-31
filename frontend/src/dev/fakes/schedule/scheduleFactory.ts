import type { Schedule, ScheduleStatus, ScheduleUpsertPayload } from '@/contracts';

export function createFakeSchedule(input: {
  draft: ScheduleUpsertPayload;
  scheduleId: string;
  userId: string;
  status: ScheduleStatus;
  geofenceArmed: boolean;
  existing?: Schedule | null;
}): Schedule {
  const { draft, existing } = input;
  const now = new Date().toISOString();

  return {
    id: input.scheduleId,
    user_id: existing?.user_id ?? input.userId,
    source_mode: draft.source_mode,
    schedule_type: draft.schedule_type,
    status: input.status,
    title: draft.title,
    notes: draft.notes ?? null,
    start_time: draft.start_time ?? null,
    end_time: draft.end_time ?? null,
    timezone: draft.timezone ?? null,
    location_name: draft.location_name ?? null,
    location_address: draft.location_address ?? null,
    latitude: draft.latitude ?? null,
    longitude: draft.longitude ?? null,
    geofence_radius_meters: draft.geofence_radius_meters ?? existing?.geofence_radius_meters ?? 100,
    geofence_armed: input.geofenceArmed,
    time_remind_offset_minutes: draft.time_remind_offset_minutes ?? 0,
    time_triggered_at: existing?.time_triggered_at ?? null,
    geo_triggered_at: existing?.geo_triggered_at ?? null,
    system_schedule_ref_id: existing?.system_schedule_ref_id ?? null,
    system_alarm_ref_id: existing?.system_alarm_ref_id ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}
