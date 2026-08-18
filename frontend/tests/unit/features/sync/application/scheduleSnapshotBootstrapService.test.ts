import { describe, expect, it, jest } from '@jest/globals';

import type { CloudScheduleSnapshot } from '../../../../../src/contracts/schedule';
import {
  ScheduleSnapshotBootstrapError,
  ScheduleSnapshotBootstrapService,
} from '../../../../../src/features/sync/application';
import type { FullScheduleSnapshotSyncService } from '../../../../../src/features/sync/application';

const EMPTY_SNAPSHOT: CloudScheduleSnapshot = { schedules: [], occurrence_overrides: [] };

function harness(localCount: number) {
  const schedules = { countSchedules: jest.fn(async () => localCount) };
  const access = { getAccountSnapshot: jest.fn(async () => EMPTY_SNAPSHOT) };
  const sync: jest.Mocked<FullScheduleSnapshotSyncService> = {
    applyFullScheduleSnapshotToSqlite: jest.fn<
      FullScheduleSnapshotSyncService['applyFullScheduleSnapshotToSqlite']
    >(async () => ({
      status: 'applied',
      changedScheduleIds: [],
      removedScheduleIds: [],
    })),
  };
  return {
    access,
    schedules,
    service: new ScheduleSnapshotBootstrapService({ access, schedules, sync }),
    sync,
  };
}

describe('ScheduleSnapshotBootstrapService', () => {
  it('skips HTTP when this account already has local rows', async () => {
    const test = harness(2);

    await expect(test.service.ensureLocalSnapshot('account-a')).resolves.toEqual({
      status: 'skipped_local_data',
    });
    expect(test.schedules.countSchedules).toHaveBeenCalledWith('account-a');
    expect(test.access.getAccountSnapshot).not.toHaveBeenCalled();
    expect(test.sync.applyFullScheduleSnapshotToSqlite).not.toHaveBeenCalled();
  });

  it('fetches and applies the full snapshot when local rows are empty', async () => {
    const test = harness(0);

    await expect(test.service.ensureLocalSnapshot('account-a')).resolves.toEqual({
      status: 'applied',
    });
    expect(test.sync.applyFullScheduleSnapshotToSqlite).toHaveBeenCalledWith({
      accountId: 'account-a',
      snapshot: EMPTY_SNAPSHOT,
    });
  });

  it('rejects a blank account before reading or fetching', async () => {
    const test = harness(0);

    await expect(test.service.ensureLocalSnapshot('  ')).rejects.toMatchObject({
      code: 'invalid_account_id',
    });
    expect(test.schedules.countSchedules).not.toHaveBeenCalled();
  });

  it('stops before reading local schedules when already aborted', async () => {
    const test = harness(0);
    const controller = new AbortController();
    controller.abort();

    await expect(
      test.service.ensureLocalSnapshot('account-a', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.schedules.countSchedules).not.toHaveBeenCalled();
    expect(test.access.getAccountSnapshot).not.toHaveBeenCalled();
    expect(test.sync.applyFullScheduleSnapshotToSqlite).not.toHaveBeenCalled();
  });

  it('surfaces a failed full-snapshot transaction', async () => {
    const test = harness(0);
    test.sync.applyFullScheduleSnapshotToSqlite.mockResolvedValueOnce({
      status: 'failed',
      changedScheduleIds: [],
      removedScheduleIds: [],
      errorCode: 'sqlite_transaction_failed',
    });

    await expect(test.service.ensureLocalSnapshot('account-a')).rejects.toEqual(
      new ScheduleSnapshotBootstrapError('sqlite_transaction_failed'),
    );
  });

  it('checks each account independently', async () => {
    const test = harness(0);

    await test.service.ensureLocalSnapshot('account-b');

    expect(test.schedules.countSchedules).toHaveBeenCalledWith('account-b');
    expect(test.sync.applyFullScheduleSnapshotToSqlite).toHaveBeenCalledWith({
      accountId: 'account-b',
      snapshot: EMPTY_SNAPSHOT,
    });
  });

  it('does not apply a snapshot after its preparation is aborted', async () => {
    const test = harness(0);
    const snapshot = createDeferred<CloudScheduleSnapshot>();
    test.access.getAccountSnapshot.mockReturnValueOnce(snapshot.promise);
    const controller = new AbortController();

    const preparation = test.service.ensureLocalSnapshot('account-a', controller.signal);
    await Promise.resolve();
    controller.abort();
    snapshot.resolve(EMPTY_SNAPSHOT);

    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.sync.applyFullScheduleSnapshotToSqlite).not.toHaveBeenCalled();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
