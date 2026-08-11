import type { CloudScheduleSnapshot } from '../../../contracts/schedule';

/** WebSocket result passed to the local synchronization boundary. */
export interface ApplyScheduleSnapshotCommand {
  messageId: string;
  accountId: string;
  snapshot: CloudScheduleSnapshot;
}

export type SnapshotApplyStatus = 'applied' | 'ignored_stale' | 'failed';

export type SnapshotApplyErrorCode =
  'invalid_snapshot' | 'account_mismatch' | 'sqlite_transaction_failed';

/** Successful or stale result for which the WebSocket owner can send an ACK. */
export interface SnapshotApplySuccessResult {
  messageId: string;
  status: Exclude<SnapshotApplyStatus, 'failed'>;
  changedScheduleIds: readonly string[];
}

/** Failed local transaction result for which the WebSocket owner must not ACK. */
export interface SnapshotApplyFailureResult {
  messageId: string;
  status: 'failed';
  changedScheduleIds: readonly string[];
  errorCode: SnapshotApplyErrorCode;
}

/** Result used by the WebSocket owner to decide whether an ACK can be sent. */
export type SnapshotApplyResult = SnapshotApplySuccessResult | SnapshotApplyFailureResult;

/** Apply server-confirmed schedule snapshots to the local SQLite projection. */
export interface ScheduleSyncService {
  /**
   * Apply every confirmed create, update, delete, and recurrence change.
   *
   * TODO(person-2): apply schedules and occurrence overrides in one SQLite
   * transaction, ignore stale revisions, then report changed schedule IDs.
   */
  applyScheduleSnapshotToSqlite(
    command: ApplyScheduleSnapshotCommand,
  ): Promise<SnapshotApplyResult>;
}
