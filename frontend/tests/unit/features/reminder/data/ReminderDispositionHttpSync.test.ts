import { describe, expect, it, jest } from '@jest/globals';

import {
  ReminderDispositionHttpSync,
  ReminderDispositionSyncResponseError,
} from '../../../../../src/features/reminder/data/http';
import type { ReminderConfirmedDisposition } from '../../../../../src/features/reminder';
import type { ApiRequest } from '../../../../../src/infrastructure/network/client';

const disposition: ReminderConfirmedDisposition = {
  schedule_id: 'schedule-a',
  state: 'confirmed',
  updated_at: '2026-08-21T08:00:00Z',
  snoozed_until: null,
  sync_status: 'pending',
};

describe('ReminderDispositionHttpSync', () => {
  it('submits a protected PUT with the backend reminder-state contract', async () => {
    const response = {
      schedule_id: 'schedule-a',
      disposition_state: 'confirmed',
      updated_at: '2026-08-21T08:00:02Z',
    };
    const request = jest.fn(async () => response) as unknown as jest.MockedFunction<ApiRequest>;
    const sync = new ReminderDispositionHttpSync(request);

    await expect(sync.submitConfirmed(disposition)).resolves.toEqual({
      schedule_id: 'schedule-a',
      accepted: true,
    });
    expect(request).toHaveBeenCalledWith('/schedule/reminder-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedule_id: 'schedule-a',
        disposition_state: 'confirmed',
      }),
    });
  });

  it('rejects a structurally invalid successful response', async () => {
    const request = jest.fn(async () => ({
      schedule_id: 'schedule-a',
      disposition_state: 'snoozed',
      updated_at: '2026-08-21T08:00:02Z',
    })) as unknown as jest.MockedFunction<ApiRequest>;
    const sync = new ReminderDispositionHttpSync(request);

    await expect(sync.submitConfirmed(disposition)).rejects.toBeInstanceOf(
      ReminderDispositionSyncResponseError,
    );
  });

  it('rejects a response for a different schedule', async () => {
    const request = jest.fn(async () => ({
      schedule_id: 'schedule-b',
      disposition_state: 'confirmed',
      updated_at: '2026-08-21T08:00:02Z',
    })) as unknown as jest.MockedFunction<ApiRequest>;
    const sync = new ReminderDispositionHttpSync(request);

    await expect(sync.submitConfirmed(disposition)).rejects.toBeInstanceOf(
      ReminderDispositionSyncResponseError,
    );
  });

  it('preserves protected-client request failures', async () => {
    const failure = new TypeError('network unavailable');
    const request = jest.fn(async () =>
      Promise.reject(failure),
    ) as unknown as jest.MockedFunction<ApiRequest>;
    const sync = new ReminderDispositionHttpSync(request);

    await expect(sync.submitConfirmed(disposition)).rejects.toBe(failure);
  });
});
