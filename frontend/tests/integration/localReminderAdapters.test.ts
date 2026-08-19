import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalReminderDelivery,
  LocalReminderDispositionSync,
  LocalReminderRecovery,
  NoopPopup,
} from '../../src/features/reminder/data/local/LocalReminderAdapters';

afterEach(() => {
  vi.useRealTimers();
});

describe('local reminder adapters', () => {
  it('returns a delivery receipt and accepts dismissal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T08:00:00Z'));
    const delivery = new LocalReminderDelivery();

    await expect(
      delivery.deliver({
        reminder_id: 'reminder-a',
        schedule_id: 'schedule-a',
        title: 'Team sync',
        strength: 'medium',
        trigger: {
          reminder_id: 'reminder-a',
          schedule_id: 'schedule-a',
          reason: 'at_time',
          triggered_at: '2026-08-19T08:00:00Z',
        },
      }),
    ).resolves.toEqual({
      delivery_id: `delivery-schedule-a-${Date.now()}`,
      schedule_id: 'schedule-a',
      delivered_at: '2026-08-19T08:00:00.000Z',
      channels: [],
      used_fallback_audio: false,
    });
    await expect(delivery.dismiss('schedule-a')).resolves.toBeUndefined();
  });

  it('keeps the placeholder popup hidden and accepts dismissal', async () => {
    const popup = new NoopPopup();

    await expect(
      popup.show({ popup_id: 'popup-a', title: 'Team sync', body: 'Starts now' }),
    ).resolves.toEqual({ popup_id: 'popup-a', visible: false });
    await expect(popup.dismiss('popup-a')).resolves.toBeUndefined();
  });

  it('returns restart registration receipts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T08:00:00Z'));
    const recovery = new LocalReminderRecovery();
    const expected = { registered: true, recovery_id: `recovery-${Date.now()}` };

    await expect(recovery.registerForRestart()).resolves.toEqual(expected);
    await expect(recovery.restoreAfterRestart()).resolves.toEqual(expected);
  });

  it('accepts a confirmed disposition for later synchronization', async () => {
    const sync = new LocalReminderDispositionSync();

    await expect(
      sync.submitConfirmed({
        schedule_id: 'schedule-a',
        state: 'confirmed',
        updated_at: '2026-08-19T08:00:00Z',
        snoozed_until: null,
        sync_status: 'pending',
      }),
    ).resolves.toEqual({ schedule_id: 'schedule-a', accepted: true });
  });
});
