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

/** Half-open local calendar range used by month and agenda views. */
export interface GetSchedulesByRangeQuery {
  accountId: string;
  /** Inclusive lower calendar date, formatted as YYYY-MM-DD. */
  startDate: string;
  /** Exclusive upper calendar date, formatted as YYYY-MM-DD. */
  endDate: string;
  timezone: string;
}

/** Account-scoped query for location schedules shown outside the calendar timeline. */
export interface GetLocationSchedulesQuery {
  accountId: string;
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

/** One location-triggered schedule shown independently from dated occurrences. */
export interface LocationScheduleView {
  scheduleId: string;
  scheduleCategory: 'location';
  title: string;
  timezone: string;
  locationName: string | null;
  reminderType: ReminderType | null;
  reminderStrength: ReminderStrength | null;
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

/** Calendar-only read capabilities built on top of the stable #167 contract. */
export interface ScheduleCalendarReadService extends ScheduleClientService {
  getSchedulesByRange(query: GetSchedulesByRangeQuery): Promise<readonly ScheduleOccurrenceView[]>;
  getLocationSchedules(query: GetLocationSchedulesQuery): Promise<readonly LocationScheduleView[]>;
}

type CalendarRepository = Pick<
  ScheduleLocalRepository,
  'listSchedules' | 'listOccurrenceOverrides'
>;

/** SQLite-backed implementation of the stable local calendar read operation. */
export class SqliteScheduleClientService implements ScheduleCalendarReadService {
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
    return this.resolveOccurrencesInRange(query.accountId, dayStart, dayEnd);
  }

  public async getSchedulesByRange(
    query: GetSchedulesByRangeQuery,
  ): Promise<readonly ScheduleOccurrenceView[]> {
    const startDate = parseDateOnly(query.startDate);
    const endDate = parseDateOnly(query.endDate);
    if (
      query.accountId.trim().length === 0 ||
      startDate === null ||
      endDate === null ||
      !isValidIanaTimezone(query.timezone)
    ) {
      throw new TypeError('Invalid local calendar range query');
    }
    const rangeStart = zonedPartsToInstant(startDate, query.timezone);
    const rangeEnd = zonedPartsToInstant(endDate, query.timezone);
    if (rangeStart >= rangeEnd) {
      throw new TypeError('Invalid local calendar range query');
    }
    return this.resolveOccurrencesInRange(query.accountId, rangeStart, rangeEnd);
  }

  public async getLocationSchedules(
    query: GetLocationSchedulesQuery,
  ): Promise<readonly LocationScheduleView[]> {
    if (query.accountId.trim().length === 0) {
      throw new TypeError('Invalid location schedule query');
    }
    const schedules = await this.repository.listSchedules(query.accountId);
    return schedules
      .filter(
        (schedule): schedule is LocalScheduleRow & { schedule_type: 'location' } =>
          schedule.schedule_type === 'location' &&
          schedule.status === 'active' &&
          schedule.reminder_disposition_state !== 'confirmed',
      )
      .map(toLocationView);
  }

  private async resolveOccurrencesInRange(
    accountId: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<readonly ScheduleOccurrenceView[]> {
    const schedules = (await this.repository.listSchedules(accountId)).filter(
      (schedule) => schedule.status === 'active',
    );
    const overrides = await this.repository.listOccurrenceOverrides(accountId);
    const overridesBySchedule = groupOverrides(overrides);
    const occurrences = schedules.flatMap((schedule) =>
      resolveScheduleInRange(
        schedule,
        overridesBySchedule.get(schedule.id) ?? [],
        rangeStart,
        rangeEnd,
      ),
    );
    return occurrences.sort(compareOccurrences);
  }
}

function resolveScheduleInRange(
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
  const rangeLower = localPartsToFloatingDate(instantToZonedParts(dayStart, scheduleTimezone));
  const lower =
    schedule.is_all_day === 1 && localDuration !== null
      ? new Date(rangeLower.getTime() - localDuration)
      : rangeLower;
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

function toLocationView(
  schedule: LocalScheduleRow & { schedule_type: 'location' },
): LocationScheduleView {
  return {
    scheduleId: schedule.id,
    scheduleCategory: schedule.schedule_type,
    title: schedule.title,
    timezone: schedule.timezone,
    locationName: schedule.location_name,
    reminderType: schedule.reminder_type,
    reminderStrength: schedule.reminder_strength,
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
