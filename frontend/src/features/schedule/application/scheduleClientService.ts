import type {
  ReminderStrength,
  ReminderType,
  ScheduleKind,
  ScheduleType,
} from '../../../contracts/schedule';
import type {
  LocalScheduleOccurrenceOverrideRow,
  LocalScheduleRow,
  ScheduleLocalRepository,
} from '../data';
import {
  addLocalDays,
  floatingDateToLocalParts,
  instantToZonedParts,
  isValidIanaTimezone,
  localPartsToFloatingDate,
  NonexistentLocalTimeError,
  parseDateOnly,
  parseIsoInstant,
  zonedPartsToInstant,
} from '../domain/scheduleDateTime';
import {
  normalizeUtcUntilForFloatingRrule,
  parseScheduleRrule,
} from '../domain/scheduleRecurrence';

/** Input from the calendar UI when a user selects one local calendar date. */
export interface GetSchedulesByDayQuery {
  accountId: string;
  /** Calendar date formatted as YYYY-MM-DD. */
  selectedDate: string;
  /** IANA timezone used to interpret the selected calendar date. */
  timezone: string;
}

/** One displayable occurrence returned to the calendar UI. */
export interface ScheduleOccurrenceView {
  scheduleId: string;
  scheduleCategory: ScheduleType;
  recurrenceMode: ScheduleKind;
  title: string;
  isAllDay: boolean;
  timezone: string;
  locationName: string | null;
  reminderType: ReminderType | null;
  reminderStrength: ReminderStrength | null;
  occurrenceStart: string | null;
  occurrenceEnd: string | null;
}

/**
 * Local calendar read operation above the SQLite adapter.
 */
export interface ScheduleClientService {
  /**
   * Return once, all-day, and expanded recurring occurrences for one day.
   *
   * The implementation expands RRULE values in their schedule timezone and
   * excludes original occurrences with cancel or replace overrides.
   */
  getSchedulesByDay(query: GetSchedulesByDayQuery): Promise<readonly ScheduleOccurrenceView[]>;
}

type CalendarRepository = Pick<
  ScheduleLocalRepository,
  'listSchedules' | 'listOccurrenceOverrides'
>;

/** SQLite-backed implementation of the stable local calendar read operation. */
export class SqliteScheduleClientService implements ScheduleClientService {
  public constructor(private readonly repository: CalendarRepository) {}

  public async getSchedulesByDay(
    query: GetSchedulesByDayQuery,
  ): Promise<readonly ScheduleOccurrenceView[]> {
    const selectedDate = parseDateOnly(query.selectedDate);
    if (
      query.accountId.trim().length === 0 ||
      selectedDate === null ||
      !isValidIanaTimezone(query.timezone)
    ) {
      throw new TypeError('Invalid local calendar query');
    }
    const dayStart = zonedPartsToInstant(selectedDate, query.timezone);
    const dayEnd = zonedPartsToInstant(addLocalDays(selectedDate, 1), query.timezone);
    const schedules = (await this.repository.listSchedules(query.accountId)).filter(
      (schedule) => schedule.status === 'active',
    );
    const overrides = await this.repository.listOccurrenceOverrides(query.accountId);
    const overridesBySchedule = groupOverrides(overrides);
    const occurrences = schedules.flatMap((schedule) =>
      resolveScheduleForDay(schedule, overridesBySchedule.get(schedule.id) ?? [], dayStart, dayEnd),
    );
    return occurrences.sort(compareOccurrences);
  }
}

function resolveScheduleForDay(
  schedule: LocalScheduleRow,
  overrides: readonly LocalScheduleOccurrenceOverrideRow[],
  dayStart: Date,
  dayEnd: Date,
): ScheduleOccurrenceView[] {
  if (schedule.schedule_type !== 'time' || schedule.start_time === null) {
    return [];
  }
  const start = requireInstant(schedule.start_time);
  const end = schedule.end_time === null ? null : requireInstant(schedule.end_time);
  if (schedule.schedule_kind === 'once') {
    const matches =
      schedule.is_all_day === 1
        ? end !== null && start < dayEnd && end > dayStart
        : start >= dayStart && start < dayEnd;
    return matches ? [toView(schedule, start, end)] : [];
  }
  if (schedule.recurrence_rule === null) {
    throw new TypeError(`Recurring schedule ${schedule.id} has no RRULE`);
  }
  const scheduleTimezone = schedule.timezone;
  if (!isValidIanaTimezone(scheduleTimezone)) {
    throw new TypeError(`Schedule ${schedule.id} has an invalid timezone`);
  }
  const localStart = instantToZonedParts(start, scheduleTimezone);
  const floatingStart = localPartsToFloatingDate(localStart);
  const localDuration = getLocalDuration(start, end, scheduleTimezone);
  const dayLower = localPartsToFloatingDate(instantToZonedParts(dayStart, scheduleTimezone));
  const lower =
    schedule.is_all_day === 1 && localDuration !== null
      ? new Date(dayLower.getTime() - localDuration)
      : dayLower;
  const upper = localPartsToFloatingDate(instantToZonedParts(dayEnd, scheduleTimezone));
  let floatingOccurrences: Date[];
  try {
    floatingOccurrences = parseScheduleRrule(
      normalizeUtcUntilForFloatingRrule(schedule.recurrence_rule, scheduleTimezone),
      floatingStart,
    ).between(lower, upper, true);
  } catch {
    throw new TypeError(`Schedule ${schedule.id} has an invalid RRULE`);
  }
  const excludedStarts = new Set(
    overrides.map((override) => requireInstant(override.occurrence_start).getTime()),
  );
  return floatingOccurrences.flatMap((floatingOccurrence) => {
    try {
      const occurrenceStart = zonedPartsToInstant(
        floatingDateToLocalParts(floatingOccurrence),
        scheduleTimezone,
      );
      if (excludedStarts.has(occurrenceStart.getTime())) {
        return [];
      }
      const occurrenceEnd =
        localDuration === null
          ? null
          : zonedPartsToInstant(
              floatingDateToLocalParts(new Date(floatingOccurrence.getTime() + localDuration)),
              scheduleTimezone,
            );
      const matches =
        schedule.is_all_day === 1
          ? occurrenceEnd !== null && occurrenceStart < dayEnd && occurrenceEnd > dayStart
          : occurrenceStart >= dayStart && occurrenceStart < dayEnd;
      if (!matches) {
        return [];
      }
      return [toView(schedule, occurrenceStart, occurrenceEnd)];
    } catch (error) {
      if (error instanceof NonexistentLocalTimeError) {
        return [];
      }
      throw error;
    }
  });
}

function getLocalDuration(start: Date, end: Date | null, timezone: string): number | null {
  if (end === null) {
    return null;
  }
  return (
    localPartsToFloatingDate(instantToZonedParts(end, timezone)).getTime() -
    localPartsToFloatingDate(instantToZonedParts(start, timezone)).getTime()
  );
}

function toView(
  schedule: LocalScheduleRow,
  occurrenceStart: Date,
  occurrenceEnd: Date | null,
): ScheduleOccurrenceView {
  return {
    scheduleId: schedule.id,
    scheduleCategory: schedule.schedule_type,
    recurrenceMode: schedule.schedule_kind,
    title: schedule.title,
    isAllDay: schedule.is_all_day === 1,
    timezone: schedule.timezone,
    locationName: schedule.location_name,
    reminderType: schedule.reminder_type,
    reminderStrength: schedule.reminder_strength,
    occurrenceStart: occurrenceStart.toISOString(),
    occurrenceEnd: occurrenceEnd?.toISOString() ?? null,
  };
}

function groupOverrides(
  overrides: readonly LocalScheduleOccurrenceOverrideRow[],
): Map<string, LocalScheduleOccurrenceOverrideRow[]> {
  const grouped = new Map<string, LocalScheduleOccurrenceOverrideRow[]>();
  for (const override of overrides) {
    const values = grouped.get(override.schedule_id) ?? [];
    values.push(override);
    grouped.set(override.schedule_id, values);
  }
  return grouped;
}

function requireInstant(value: string): Date {
  const parsed = parseIsoInstant(value);
  if (parsed === null) {
    throw new TypeError(`Invalid timestamp ${value}`);
  }
  return parsed;
}

function compareOccurrences(left: ScheduleOccurrenceView, right: ScheduleOccurrenceView): number {
  if (left.isAllDay !== right.isAllDay) {
    return left.isAllDay ? -1 : 1;
  }
  return (
    (left.occurrenceStart ?? '').localeCompare(right.occurrenceStart ?? '') ||
    left.title.localeCompare(right.title) ||
    left.scheduleId.localeCompare(right.scheduleId)
  );
}
