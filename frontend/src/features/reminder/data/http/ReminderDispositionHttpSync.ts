import { parseReminderDispositionSyncResponse } from '../../../../contracts/reminder';
import type { ApiRequest } from '../../../../infrastructure/network/client';
import type {
  ReminderConfirmedDisposition,
  ReminderDispositionSyncPort,
  ReminderDispositionSyncReceipt,
} from '../../application/interfaces';

export class ReminderDispositionSyncResponseError extends Error {
  constructor() {
    super('Reminder disposition sync response is invalid');
    this.name = 'ReminderDispositionSyncResponseError';
  }
}

export class ReminderDispositionHttpSync implements ReminderDispositionSyncPort {
  constructor(private readonly request: ApiRequest) {}

  async submitConfirmed(
    disposition: ReminderConfirmedDisposition,
  ): Promise<ReminderDispositionSyncReceipt> {
    const response = await this.request<unknown>('/schedule/reminder-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedule_id: disposition.schedule_id,
        disposition_state: 'confirmed',
      }),
    });
    const parsed = parseReminderDispositionSyncResponse(response);
    if (!parsed || parsed.schedule_id !== disposition.schedule_id) {
      throw new ReminderDispositionSyncResponseError();
    }
    return {
      schedule_id: parsed.schedule_id,
      accepted: true,
    };
  }
}
