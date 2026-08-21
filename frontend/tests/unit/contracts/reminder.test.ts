import { describe, expect, it } from '@jest/globals';

import { parseReminderDispositionSyncResponse } from '../../../src/contracts/reminder';

const validResponse = {
  schedule_id: 'schedule-a',
  disposition_state: 'confirmed',
  updated_at: '2026-08-21T08:00:00Z',
};

describe('parseReminderDispositionSyncResponse', () => {
  it('accepts the backend final reminder-state response', () => {
    expect(parseReminderDispositionSyncResponse(validResponse)).toEqual(validResponse);
  });

  it.each([
    ['non-object', []],
    ['missing field', { schedule_id: 'schedule-a', disposition_state: 'confirmed' }],
    ['unknown field', { ...validResponse, sync_status: 'synced' }],
    ['blank schedule id', { ...validResponse, schedule_id: '   ' }],
    ['unsupported disposition', { ...validResponse, disposition_state: 'snoozed' }],
    ['invalid timestamp', { ...validResponse, updated_at: '2026-08-21' }],
  ])('rejects %s', (_name, response) => {
    expect(parseReminderDispositionSyncResponse(response)).toBeUndefined();
  });
});
