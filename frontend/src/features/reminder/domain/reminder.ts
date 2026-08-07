/** 本地执行架构定义的提醒类型。 */
export type ReminderType =
  'at_time' | 'before_start' | 'arrive_location' | 'return_to_recorded_location';

export type ReminderStrength = 'low' | 'medium' | 'high';
export type ReminderDispositionState = 'pending' | 'confirmed' | 'snoozed';
export type ReminderSyncStatus = 'pending' | 'synced';
export const DEFAULT_SNOOZE_MINUTES = 10;
export type LocalScheduleStatus = 'active' | 'deleted';
export type LocalScheduleKind = 'once' | 'recurring';
export type LocalScheduleType = 'time' | 'location';

export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export type LocationSample = GeoPoint & {
  accuracy_meters: number;
  observed_at: string;
};

/** 一条提醒配置，作为本地日程记录的字段保存。 */
export type ReminderConfiguration = {
  reminder_type: ReminderType;
  reminder_trigger_at: string | null;
  reminder_offset_minutes: number | null;
  reminder_strength: ReminderStrength;
};

/** 仅属于设备的运行字段，不会作为云端独立提醒表上传。 */
export type ReminderRuntimeState = {
  reminder_disposition_state: ReminderDispositionState | null;
  next_trigger_at: string | null;
  snoozed_until: string | null;
  geofence_armed: boolean;
  disposition_updated_at: string | null;
  sync_status: ReminderSyncStatus;
  recorded_location: GeoPoint | null;
};

/** 提醒运行时消费的本地日程投影。 */
export type LocalReminderSchedule = {
  id: string;
  account_id: string;
  title: string;
  schedule_type: LocalScheduleType;
  schedule_kind: LocalScheduleKind;
  is_all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  timezone: string;
  recurrence_rule: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_meters: number;
  reminder: ReminderConfiguration | null;
  runtime: ReminderRuntimeState;
  status: LocalScheduleStatus;
  revision: number;
  cloud_revision: number;
  updated_at: string;
};

export type ReminderTriggerReason =
  | 'at_time'
  | 'before_start'
  | 'arrive_location'
  | 'return_to_recorded_location'
  | 'snooze_expired'
  | 'mock';

export type ReminderTrigger = {
  reminder_id: string;
  schedule_id: string;
  reason: ReminderTriggerReason;
  triggered_at: string;
};

export type DeliveryChannel = 'system_notification' | 'popup' | 'vibration' | 'tts' | 'local_sound';

export type ReminderDeliveryRequest = {
  reminder_id: string;
  schedule_id: string;
  title: string;
  strength: ReminderStrength;
  trigger: ReminderTrigger;
};

export type ReminderDeliveryReceipt = {
  delivery_id: string;
  schedule_id: string;
  delivered_at: string;
  channels: readonly DeliveryChannel[];
  used_fallback_audio: boolean;
};

export type ReminderDisposition = {
  schedule_id: string;
  state: ReminderDispositionState;
  updated_at: string;
  snoozed_until: string | null;
  sync_status: ReminderSyncStatus;
};

export type ReminderRegistration = {
  schedule_id: string;
  time_listener_id: string | null;
  location_listener_id: string | null;
  alarm_id: string | null;
};
