export type ScheduleType = 'time' | 'location';

export const SCHEDULE_CATEGORIES = [
  'work',
  'study',
  'exercise',
  'entertainment',
  'social',
  'rest',
  'personal',
  'other',
] as const;

export type ScheduleCategory = (typeof SCHEDULE_CATEGORIES)[number];

export type ScheduleKind = 'once' | 'recurring';

export type RecurringDeleteScope = 'this_occurrence' | 'this_and_future' | 'entire_series';

export type ScheduleStatus = 'active' | 'deleted';

export type ReminderType =
  'at_time' | 'before_start' | 'arrive_location' | 'return_to_recorded_location';

export type ReminderStrength = 'low' | 'medium' | 'high';

export type ReminderDispositionState = 'confirmed';

export type OccurrenceOverrideAction = 'cancel' | 'replace';

/** Final schedule fields already committed by the cloud service. */
export interface ScheduleSnapshot {
  id: string;
  account_id: string;
  schedule_type: ScheduleType;
  schedule_kind: ScheduleKind;
  category: ScheduleCategory | null;
  title: string;
  is_all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  timezone: string;
  recurrence_rule: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  reminder_type: ReminderType | null;
  reminder_trigger_at: string | null;
  reminder_offset_minutes: number | null;
  reminder_strength: ReminderStrength | null;
  reminder_disposition_state: ReminderDispositionState | null;
  status: ScheduleStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Final recurring exception fields already committed by the cloud service. */
export interface ScheduleOccurrenceOverrideSnapshot {
  id: string;
  schedule_id: string;
  occurrence_start: string;
  action: OccurrenceOverrideAction;
  replacement_schedule_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One WebSocket command result, including every local row it can affect. */
export interface CloudScheduleSnapshot {
  schedules: readonly ScheduleSnapshot[];
  occurrence_overrides: readonly ScheduleOccurrenceOverrideSnapshot[];
}
