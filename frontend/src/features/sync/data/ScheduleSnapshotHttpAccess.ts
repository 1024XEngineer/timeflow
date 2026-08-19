import { parseScheduleSnapshotResponse } from '../../../contracts/sync';
import type { ApiRequest } from '../../../infrastructure/network/client';
import type { ScheduleSnapshotAccess } from '../application';

export class ScheduleSnapshotResponseError extends Error {
  constructor() {
    super('Schedule snapshot response is invalid');
    this.name = 'ScheduleSnapshotResponseError';
  }
}

export class ScheduleSnapshotHttpAccess implements ScheduleSnapshotAccess {
  constructor(private readonly request: ApiRequest) {}

  async getAccountSnapshot(signal?: AbortSignal) {
    const response = signal
      ? await this.request<unknown>('/schedule/snapshot', { signal })
      : await this.request<unknown>('/schedule/snapshot');
    const snapshot = parseScheduleSnapshotResponse(response);
    if (!snapshot) throw new ScheduleSnapshotResponseError();
    return snapshot;
  }
}
