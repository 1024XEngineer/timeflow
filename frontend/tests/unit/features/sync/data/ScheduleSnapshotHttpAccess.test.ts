import { describe, expect, it, jest } from '@jest/globals';

import { ScheduleSnapshotHttpAccess } from '../../../../../src/features/sync/data';
import type { ApiRequest } from '../../../../../src/infrastructure/network/client';

describe('ScheduleSnapshotHttpAccess', () => {
  it('requests the protected relative endpoint and returns a parsed snapshot', async () => {
    const response = { schedules: [], occurrence_overrides: [] };
    const request = jest.fn(async () => response) as unknown as jest.MockedFunction<ApiRequest>;
    const access = new ScheduleSnapshotHttpAccess(request);

    await expect(access.getAccountSnapshot()).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith('/schedule/snapshot');
  });

  it('rejects a structurally invalid successful response', async () => {
    const request = jest.fn(async () => ({
      schedules: [],
    })) as unknown as jest.MockedFunction<ApiRequest>;
    const access = new ScheduleSnapshotHttpAccess(request);

    await expect(access.getAccountSnapshot()).rejects.toMatchObject({
      name: 'ScheduleSnapshotResponseError',
    });
  });

  it('preserves protected-client request failures', async () => {
    const failure = new TypeError('network unavailable');
    const request = jest.fn(async () =>
      Promise.reject(failure),
    ) as unknown as jest.MockedFunction<ApiRequest>;
    const access = new ScheduleSnapshotHttpAccess(request);

    await expect(access.getAccountSnapshot()).rejects.toBe(failure);
  });

  it('passes the preparation abort signal to the protected request', async () => {
    const response = { schedules: [], occurrence_overrides: [] };
    const request = jest.fn(async () => response) as unknown as jest.MockedFunction<ApiRequest>;
    const access = new ScheduleSnapshotHttpAccess(request);
    const controller = new AbortController();

    await access.getAccountSnapshot(controller.signal);

    expect(request).toHaveBeenCalledWith('/schedule/snapshot', { signal: controller.signal });
  });
});
