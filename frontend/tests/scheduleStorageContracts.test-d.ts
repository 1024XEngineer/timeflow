import type { ReminderDispositionState as CloudReminderDispositionState } from '../src/contracts/schedule';
import type {
  CloudScheduleRow,
  LocalReminderDispositionState,
  LocalReminderRuntimeUpdate,
  LocalScheduleOccurrenceOverrideRow,
  LocalScheduleRow,
  ScheduleLocalRepository,
} from '../src/features/schedule/data';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type Assert<Condition extends true> = Condition;

export type LocalReminderStateContract = Assert<
  Equal<LocalReminderDispositionState, 'pending' | 'confirmed' | 'snoozed'>
>;

export type LocalSnoozeDoesNotEnterCloudContract = Assert<
  Equal<Extract<'snoozed', CloudReminderDispositionState>, never>
>;

export type LocalScheduleStorageColumnsContract = Assert<
  Equal<
    keyof LocalScheduleRow,
    | 'id'
    | 'account_id'
    | 'schedule_type'
    | 'schedule_kind'
    | 'title'
    | 'is_all_day'
    | 'start_time'
    | 'end_time'
    | 'timezone'
    | 'recurrence_rule'
    | 'location_name'
    | 'latitude'
    | 'longitude'
    | 'reminder_type'
    | 'reminder_trigger_at'
    | 'reminder_offset_minutes'
    | 'reminder_strength'
    | 'reminder_disposition_state'
    | 'next_trigger_at'
    | 'snoozed_until'
    | 'geofence_armed'
    | 'disposition_updated_at'
    | 'sync_status'
    | 'status'
    | 'cloud_revision'
    | 'updated_at'
  >
>;

export type CloudScheduleStorageColumnsContract = Assert<
  Equal<
    keyof CloudScheduleRow,
    | 'id'
    | 'account_id'
    | 'schedule_type'
    | 'schedule_kind'
    | 'title'
    | 'is_all_day'
    | 'start_time'
    | 'end_time'
    | 'timezone'
    | 'recurrence_rule'
    | 'location_name'
    | 'latitude'
    | 'longitude'
    | 'reminder_type'
    | 'reminder_trigger_at'
    | 'reminder_offset_minutes'
    | 'reminder_strength'
    | 'reminder_disposition_state'
    | 'status'
    | 'cloud_revision'
    | 'updated_at'
  >
>;

export type LocalReminderRuntimeColumnsContract = Assert<
  Equal<
    keyof LocalReminderRuntimeUpdate,
    | 'reminder_disposition_state'
    | 'next_trigger_at'
    | 'snoozed_until'
    | 'geofence_armed'
    | 'disposition_updated_at'
    | 'sync_status'
  >
>;

export type LocalOccurrenceOverrideStorageColumnsContract = Assert<
  Equal<
    keyof LocalScheduleOccurrenceOverrideRow,
    'id' | 'schedule_id' | 'occurrence_start' | 'action' | 'replacement_schedule_id'
  >
>;

export type LocalRepositoryOperationsContract = Assert<
  Equal<
    keyof ScheduleLocalRepository,
    | 'getSchedule'
    | 'listSchedules'
    | 'applyCloudSchedule'
    | 'updateReminderRuntime'
    | 'purgeSchedule'
    | 'upsertOccurrenceOverride'
    | 'listOccurrenceOverrides'
  >
>;
