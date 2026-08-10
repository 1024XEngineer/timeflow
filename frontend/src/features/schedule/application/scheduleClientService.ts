import type {
  ReminderStrength,
  ReminderType,
  ScheduleKind,
  ScheduleType,
} from '../../../contracts/schedule';

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
  scheduleType: ScheduleType;
  scheduleKind: ScheduleKind;
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
 * Local calendar read operation owned by person two.
 *
 * Implementations will live above the SQLite adapter. This interface contains
 * no database access, RRULE expansion, revision comparison, or transaction
 * logic yet.
 */
export interface ScheduleClientService {
  /**
   * Return once, all-day, and expanded recurring occurrences for one day.
   *
   * TODO(person-2): read local SQLite, expand RRULE values, then apply local
   * occurrence overrides before returning display rows.
   */
  getSchedulesByDay(query: GetSchedulesByDayQuery): Promise<readonly ScheduleOccurrenceView[]>;
}
