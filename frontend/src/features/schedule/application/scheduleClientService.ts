import type { CloudScheduleSnapshot, ScheduleSnapshot } from '../../../contracts/schedule';

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
  schedule: ScheduleSnapshot;
  occurrenceStart: string | null;
  occurrenceEnd: string | null;
}

/** WebSocket result passed to the local synchronization boundary. */
export interface ApplyScheduleSnapshotCommand {
  messageId: string;
  accountId: string;
  snapshot: CloudScheduleSnapshot;
}

export type SnapshotApplyStatus = 'applied' | 'ignored_stale' | 'failed';

/** Result used by the WebSocket owner to decide whether an ACK can be sent. */
export interface SnapshotApplyResult {
  messageId: string;
  status: SnapshotApplyStatus;
  changedScheduleIds: readonly string[];
  errorCode?: string;
}

/**
 * Two client-side schedule operations owned by person two.
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

  /**
   * Apply every server-confirmed create, update, delete, and recurrence change.
   *
   * TODO(person-2): apply schedules and occurrence overrides in one SQLite
   * transaction, ignore stale revisions, then report changed schedule IDs.
   */
  applyScheduleSnapshotToSqlite(
    command: ApplyScheduleSnapshotCommand,
  ): Promise<SnapshotApplyResult>;
}
