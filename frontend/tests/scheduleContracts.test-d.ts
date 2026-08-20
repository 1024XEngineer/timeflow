import type {
  RecurringDeleteScope,
  ReminderDispositionState,
  ScheduleCategory,
  ScheduleSnapshot,
} from '../src/contracts/schedule';
import type {
  GetLocationSchedulesQuery,
  GetSchedulesByDayQuery,
  GetSchedulesByRangeQuery,
  LocationScheduleView,
  ScheduleCalendarReadService,
  ScheduleClientService,
  ScheduleOccurrenceView,
} from '../src/features/schedule/application';
import type {
  ApplyFullScheduleSnapshotCommand,
  FullScheduleSnapshotSyncService,
  FullSnapshotApplyResult,
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

export type ScheduleCategoryContract = Assert<
  Equal<
    ScheduleCategory,
    'work' | 'study' | 'exercise' | 'entertainment' | 'social' | 'rest' | 'personal' | 'other'
  >
>;

export type SnapshotReminderDispositionContract = Assert<
  Equal<ScheduleSnapshot['reminder_disposition_state'], ReminderDispositionState | null>
>;

export type SnapshotCategoryContract = Assert<
  Equal<ScheduleSnapshot['category'], ScheduleCategory | null>
>;

export type LocalReminderStateIsNotCloudDispositionContract = Assert<
  Equal<Extract<'snoozed' | 'pending' | 'done', ReminderDispositionState>, never>
>;

export type ScheduleClientOperationsContract = Assert<
  Equal<keyof ScheduleClientService, 'getSchedulesByDay'>
>;

export type ScheduleClientDayQueryContract = Assert<
  Equal<Parameters<ScheduleClientService['getSchedulesByDay']>, [GetSchedulesByDayQuery]>
>;

export type ScheduleClientDayResultContract = Assert<
  Equal<
    ReturnType<ScheduleClientService['getSchedulesByDay']>,
    Promise<readonly ScheduleOccurrenceView[]>
  >
>;

export type ScheduleCalendarReadOperationsContract = Assert<
  Equal<
    keyof ScheduleCalendarReadService,
    'getSchedulesByDay' | 'getSchedulesByRange' | 'getLocationSchedules'
  >
>;

export type ScheduleCalendarRangeQueryContract = Assert<
  Equal<Parameters<ScheduleCalendarReadService['getSchedulesByRange']>, [GetSchedulesByRangeQuery]>
>;

export type ScheduleCalendarRangeResultContract = Assert<
  Equal<
    ReturnType<ScheduleCalendarReadService['getSchedulesByRange']>,
    Promise<readonly ScheduleOccurrenceView[]>
  >
>;

export type ScheduleCalendarLocationQueryContract = Assert<
  Equal<
    Parameters<ScheduleCalendarReadService['getLocationSchedules']>,
    [GetLocationSchedulesQuery]
  >
>;

export type ScheduleCalendarLocationResultContract = Assert<
  Equal<
    ReturnType<ScheduleCalendarReadService['getLocationSchedules']>,
    Promise<readonly LocationScheduleView[]>
  >
>;

export type ScheduleSyncOperationsContract = Assert<
  Equal<keyof ScheduleSyncService, 'applyScheduleSnapshotToSqlite'>
>;

export type FullScheduleSnapshotSyncOperationsContract = Assert<
  Equal<keyof FullScheduleSnapshotSyncService, 'applyFullScheduleSnapshotToSqlite'>
>;

export type FullScheduleSnapshotSyncCommandContract = Assert<
  Equal<
    Parameters<FullScheduleSnapshotSyncService['applyFullScheduleSnapshotToSqlite']>,
    [ApplyFullScheduleSnapshotCommand]
  >
>;

export type FullScheduleSnapshotSyncResultContract = Assert<
  Equal<
    ReturnType<FullScheduleSnapshotSyncService['applyFullScheduleSnapshotToSqlite']>,
    Promise<FullSnapshotApplyResult>
  >
>;

export type ScheduleOccurrenceViewContract = Assert<
  Equal<
    keyof ScheduleOccurrenceView,
    | 'scheduleId'
    | 'scheduleCategory'
    | 'category'
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

export type LocationScheduleViewContract = Assert<
  Equal<
    keyof LocationScheduleView,
    | 'scheduleId'
    | 'scheduleCategory'
    | 'category'
    | 'title'
    | 'timezone'
    | 'locationName'
    | 'reminderType'
    | 'reminderStrength'
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
