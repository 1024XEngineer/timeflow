import type { CloudScheduleSnapshot } from '../../../contracts/schedule';
import type {
  FullScheduleSnapshotSyncService,
  SnapshotApplyErrorCode,
} from './scheduleSyncService';

export interface ScheduleCountReader {
  countSchedules(accountId: string): Promise<number>;
}

export interface ScheduleSnapshotAccess {
  getAccountSnapshot(signal?: AbortSignal): Promise<CloudScheduleSnapshot>;
}

export type ScheduleSnapshotBootstrapResult =
  { readonly status: 'skipped_local_data' } | { readonly status: 'applied' };

export type ScheduleSnapshotBootstrapErrorCode = 'invalid_account_id' | SnapshotApplyErrorCode;

export class ScheduleSnapshotBootstrapError extends Error {
  constructor(public readonly code: ScheduleSnapshotBootstrapErrorCode) {
    super(code);
    this.name = 'ScheduleSnapshotBootstrapError';
  }
}

export class ScheduleSnapshotBootstrapService {
  constructor(
    private readonly dependencies: {
      readonly access: ScheduleSnapshotAccess;
      readonly schedules: ScheduleCountReader;
      readonly sync: FullScheduleSnapshotSyncService;
    },
  ) {}

  async ensureLocalSnapshot(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<ScheduleSnapshotBootstrapResult> {
    throwIfAborted(signal);
    if (accountId.trim().length === 0) {
      throw new ScheduleSnapshotBootstrapError('invalid_account_id');
    }
    if ((await this.dependencies.schedules.countSchedules(accountId)) > 0) {
      return { status: 'skipped_local_data' };
    }

    throwIfAborted(signal);
    const snapshot = await this.dependencies.access.getAccountSnapshot(signal);
    throwIfAborted(signal);
    assertSnapshotBelongsToAccount(accountId, snapshot);
    const result = await this.dependencies.sync.applyFullScheduleSnapshotToSqlite({
      accountId,
      snapshot,
    });
    if (result.status === 'failed') {
      throw new ScheduleSnapshotBootstrapError(result.errorCode);
    }
    return { status: 'applied' };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Schedule snapshot preparation aborted');
  error.name = 'AbortError';
  throw error;
}

function assertSnapshotBelongsToAccount(accountId: string, snapshot: CloudScheduleSnapshot): void {
  const schedulesById = new Map(snapshot.schedules.map((schedule) => [schedule.id, schedule]));
  for (const schedule of snapshot.schedules) {
    if (schedule.account_id !== accountId) {
      throw new ScheduleSnapshotBootstrapError('account_mismatch');
    }
  }
  for (const override of snapshot.occurrence_overrides) {
    const parent = schedulesById.get(override.schedule_id);
    if (parent === undefined || parent.account_id !== accountId) {
      throw new ScheduleSnapshotBootstrapError('account_mismatch');
    }
    if (override.replacement_schedule_id !== null) {
      const replacement = schedulesById.get(override.replacement_schedule_id);
      if (replacement === undefined || replacement.account_id !== accountId) {
        throw new ScheduleSnapshotBootstrapError('account_mismatch');
      }
    }
  }
}
