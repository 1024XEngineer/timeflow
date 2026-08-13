import { describe, expect, it } from '@jest/globals';

import {
  LocalReminderDelivery,
  LocalReminderDispositionSync,
  LocalReminderRecovery,
  LocalSystemNotification,
  NoopPopup,
} from '../../../../src/features/reminder/data/local/LocalReminderAdapters';

describe('LocalReminderAdapters', () => {
  it('returns a delivery receipt without claiming presentation channels', async () => {
    const delivery = new LocalReminderDelivery();
    await expect(
      delivery.deliver({
        reminder_id: 'r1',
        schedule_id: 's1',
        title: '晨会',
        strength: 'medium',
        trigger: {
          reminder_id: 'r1',
          schedule_id: 's1',
          reason: 'at_time',
          triggered_at: '2026-08-13T08:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({
      schedule_id: 's1',
      channels: [],
      used_fallback_audio: false,
    });
  });

  it('keeps popup hidden and system notification shown as placeholders', async () => {
    const popup = new NoopPopup();
    const notification = new LocalSystemNotification();
    await expect(popup.show({ popup_id: 'p1', title: '晨会', body: '会议室' })).resolves.toEqual({
      popup_id: 'p1',
      visible: false,
    });
    await expect(
      notification.show({ notification_id: 'n1', title: '晨会', body: '会议室' }),
    ).resolves.toEqual({ notification_id: 'n1', shown: true });
  });

  it('accepts local recovery and confirmed disposition sync', async () => {
    const recovery = new LocalReminderRecovery();
    const sync = new LocalReminderDispositionSync();
    await expect(recovery.registerForRestart()).resolves.toMatchObject({ registered: true });
    await expect(
      sync.submitConfirmed({
        schedule_id: 's1',
        state: 'confirmed',
        updated_at: '2026-08-13T08:00:00.000Z',
        snoozed_until: null,
        sync_status: 'pending',
      }),
    ).resolves.toEqual({ schedule_id: 's1', accepted: true });
  });
});
