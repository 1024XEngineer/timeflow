import type {
  CloudScheduleSnapshot,
  ScheduleOccurrenceOverrideSnapshot,
  ScheduleSnapshot,
} from './schedule';

const SCHEDULE_KEYS = [
  'id',
  'account_id',
  'schedule_type',
  'schedule_kind',
  'title',
  'is_all_day',
  'start_time',
  'end_time',
  'timezone',
  'recurrence_rule',
  'location_name',
  'latitude',
  'longitude',
  'reminder_type',
  'reminder_trigger_at',
  'reminder_offset_minutes',
  'reminder_strength',
  'reminder_disposition_state',
  'status',
  'revision',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

const OVERRIDE_KEYS = [
  'id',
  'schedule_id',
  'occurrence_start',
  'action',
  'replacement_schedule_id',
  'created_at',
  'updated_at',
] as const;

export function parseScheduleSnapshotResponse(value: unknown): CloudScheduleSnapshot | undefined {
  if (!hasExactKeys(value, ['schedules', 'occurrence_overrides'])) return undefined;
  if (!Array.isArray(value.schedules) || !Array.isArray(value.occurrence_overrides)) {
    return undefined;
  }
  if (!value.schedules.every(isScheduleSnapshot)) return undefined;
  if (!value.occurrence_overrides.every(isOccurrenceOverrideSnapshot)) return undefined;
  return {
    schedules: value.schedules,
    occurrence_overrides: value.occurrence_overrides,
  };
}

function isScheduleSnapshot(value: unknown): value is ScheduleSnapshot {
  return (
    hasExactKeys(value, SCHEDULE_KEYS) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.account_id) &&
    isOneOf(value.schedule_type, ['time', 'location']) &&
    isOneOf(value.schedule_kind, ['once', 'recurring']) &&
    isNonBlankString(value.title) &&
    typeof value.is_all_day === 'boolean' &&
    isNullableAwareTimestamp(value.start_time) &&
    isNullableAwareTimestamp(value.end_time) &&
    isNonBlankString(value.timezone) &&
    isNullableString(value.recurrence_rule) &&
    isNullableString(value.location_name) &&
    isNullableFiniteNumber(value.latitude) &&
    isNullableFiniteNumber(value.longitude) &&
    isNullableOneOf(value.reminder_type, [
      'at_time',
      'before_start',
      'arrive_location',
      'return_to_recorded_location',
    ]) &&
    isNullableAwareTimestamp(value.reminder_trigger_at) &&
    isNullableNonNegativeInteger(value.reminder_offset_minutes) &&
    isNullableOneOf(value.reminder_strength, ['low', 'medium', 'high']) &&
    isNullableOneOf(value.reminder_disposition_state, ['confirmed']) &&
    isOneOf(value.status, ['active', 'deleted']) &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    isAwareTimestamp(value.created_at) &&
    isAwareTimestamp(value.updated_at) &&
    isNullableAwareTimestamp(value.deleted_at)
  );
}

function isOccurrenceOverrideSnapshot(value: unknown): value is ScheduleOccurrenceOverrideSnapshot {
  return (
    hasExactKeys(value, OVERRIDE_KEYS) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.schedule_id) &&
    isAwareTimestamp(value.occurrence_start) &&
    isOneOf(value.action, ['cancel', 'replace']) &&
    isNullableString(value.replacement_schedule_id) &&
    isAwareTimestamp(value.created_at) &&
    isAwareTimestamp(value.updated_at)
  );
}

function hasExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Record<Keys[number], unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && values.includes(value as Values[number]);
}

function isNullableOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] | null {
  return value === null || isOneOf(value, values);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isAwareTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isNullableAwareTimestamp(value: unknown): value is string | null {
  return value === null || isAwareTimestamp(value);
}
