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
