import type {
  RecurringDeleteScope,
  ReminderDispositionState,
  ScheduleSnapshot,
} from '../src/contracts/schedule';
import type {
  ScheduleClientService,
  ScheduleOccurrenceView,
} from '../src/features/schedule/application';
import type {
  ScheduleSyncService,
  SnapshotApplyErrorCode,
  SnapshotApplyFailureResult,
  SnapshotApplyStatus,
  SnapshotApplySuccessResult,
} from '../src/features/sync/application';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type Assert<Condition extends true> = Condition;

export type RecurringDeleteScopeContract = Assert<
  Equal<RecurringDeleteScope, 'this_occurrence' | 'this_and_future' | 'entire_series'>
>;

export type ReminderDispositionStateContract = Assert<Equal<ReminderDispositionState, 'confirmed'>>;

export type SnapshotReminderDispositionContract = Assert<
  Equal<ScheduleSnapshot['reminder_disposition_state'], ReminderDispositionState | null>
>;

export type LocalReminderStateIsNotCloudDispositionContract = Assert<
  Equal<Extract<'snoozed' | 'pending' | 'done', ReminderDispositionState>, never>
>;

export type ScheduleClientOperationsContract = Assert<
  Equal<keyof ScheduleClientService, 'getSchedulesByDay'>
>;

export type ScheduleSyncOperationsContract = Assert<
  Equal<keyof ScheduleSyncService, 'applyScheduleSnapshotToSqlite'>
>;

export type ScheduleOccurrenceViewContract = Assert<
  Equal<
    keyof ScheduleOccurrenceView,
    | 'scheduleId'
    | 'scheduleCategory'
    | 'recurrenceMode'
    | 'title'
    | 'isAllDay'
    | 'timezone'
    | 'locationName'
    | 'reminderType'
    | 'reminderStrength'
    | 'occurrenceStart'
    | 'occurrenceEnd'
  >
>;

export type SnapshotApplyStatusContract = Assert<
  Equal<SnapshotApplyStatus, 'applied' | 'ignored_stale' | 'failed'>
>;

export type SnapshotApplyErrorCodeContract = Assert<
  Equal<
    SnapshotApplyErrorCode,
    'invalid_snapshot' | 'account_mismatch' | 'sqlite_transaction_failed'
  >
>;

export type SnapshotApplySuccessContract = Assert<
  Equal<SnapshotApplySuccessResult['status'], 'applied' | 'ignored_stale'>
>;

export type SnapshotApplyFailureContract = Assert<
  Equal<SnapshotApplyFailureResult['errorCode'], SnapshotApplyErrorCode>
>;
