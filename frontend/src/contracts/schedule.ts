export type ScheduleSourceMode = 'manual' | 'voice';
export type ScheduleType = 'time' | 'location';
export type ScheduleStatus = 'scheduled' | 'done' | 'deleted';

/** 与后端接口共享的已持久化日程结构。 */
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
