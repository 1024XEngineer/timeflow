import { describe, expect, it, jest } from '@jest/globals';

import type {
  AlertDialogPort,
  AlertDialogRequest,
} from '../../../../src/features/reminder/application/interfaces';
import { AlertReminderPresenter } from '../../../../src/features/reminder/presentation/AlertReminderPresenter';
import type {
  ReminderDeliveryRequest,
  ReminderTriggerReason,
} from '../../../../src/features/reminder/domain';

const NOW_ISO = '2026-08-13T08:00:00.000Z';

function request(
  reason: ReminderTriggerReason,
  overrides: Partial<ReminderDeliveryRequest> = {},
): ReminderDeliveryRequest {
  return {
    reminder_id: 'reminder-schedule-time',
    schedule_id: 'schedule-time',
    title: '晨会',
    strength: 'medium',
    trigger: {
      reminder_id: 'reminder-schedule-time',
      schedule_id: 'schedule-time',
      reason,
      triggered_at: NOW_ISO,
    },
    ...overrides,
  };
}

describe('AlertReminderPresenter', () => {
  it('shows the reason-specific copy and default title fallback', async () => {
    const shown: AlertDialogRequest[] = [];
    const dialog: AlertDialogPort = {
      show: jest.fn(async (dialogRequest: AlertDialogRequest) => {
        shown.push(dialogRequest);
      }),
    };
    const presenter = new AlertReminderPresenter(dialog);

    await presenter.show(request('at_time'));
    await presenter.show(request('before_start'));
    await presenter.show(request('arrive_location'));
    await presenter.show(request('return_to_recorded_location'));
    await presenter.show(request('snooze_expired'));
    await presenter.show(request('at_time', { title: '' }));

    expect(shown.map((item) => item.message)).toEqual([
      '已到提醒时间，请及时处理。',
      '日程即将开始，请及时处理。',
      '您已进入目标地点附近，请及时处理。',
      '您已回到记录地点附近，请及时处理。',
      '延后提醒时间已到，请及时处理。',
      '已到提醒时间，请及时处理。',
    ]);
    expect(shown[5]?.title).toBe('日程提醒');
  });

  it('emits confirm and snooze until hide suppresses further actions', async () => {
    let lastRequest: AlertDialogRequest | undefined;
    const dialog: AlertDialogPort = {
      show: jest.fn(async (dialogRequest: AlertDialogRequest) => {
        lastRequest = dialogRequest;
      }),
    };
    const presenter = new AlertReminderPresenter(dialog);
    const listener = jest.fn();
    const unsubscribe = presenter.onAction(listener);

    await presenter.show(request('at_time'));
    lastRequest?.buttons[1]?.onPress?.();
    lastRequest?.buttons[0]?.onPress?.();
    expect(listener).toHaveBeenNthCalledWith(1, {
      schedule_id: 'schedule-time',
      action: 'confirm',
    });
    expect(listener).toHaveBeenNthCalledWith(2, { schedule_id: 'schedule-time', action: 'snooze' });

    await presenter.hide('schedule-time');
    lastRequest?.buttons[1]?.onPress?.();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
