import { describe, expect, it, jest } from '@jest/globals';

import type {
  AlertDialogPort,
  AlertDialogRequest,
} from '../../../../../src/features/reminder/application/interfaces';
import { AlertReminderPresenter } from '../../../../../src/features/reminder/presentation/AlertReminderPresenter';
import type { ReminderDeliveryRequest } from '../../../../../src/features/reminder/domain';

function createDialog(): { dialog: AlertDialogPort; requests: AlertDialogRequest[] } {
  const requests: AlertDialogRequest[] = [];
  return {
    dialog: {
      show: jest.fn(async (request: AlertDialogRequest) => {
        requests.push(request);
      }),
    },
    requests,
  };
}

function deliveryRequest(
  overrides: Partial<ReminderDeliveryRequest> = {},
): ReminderDeliveryRequest {
  return {
    reminder_id: 'reminder-1',
    schedule_id: 'schedule-1',
    title: '喝水',
    strength: 'medium',
    trigger: {
      reminder_id: 'reminder-1',
      schedule_id: 'schedule-1',
      reason: 'at_time',
      triggered_at: '2026-08-20T08:00:00Z',
    },
    ...overrides,
  };
}

describe('AlertReminderPresenter', () => {
  it('shows the dialog with the reason-specific message and returns a visible receipt', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);

    const receipt = await presenter.show(deliveryRequest());

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      title: '喝水',
      message: '已到提醒时间，请及时处理。',
    });
    expect(receipt).toEqual({ presentation_id: 'alert-schedule-1', visible: true });
  });

  it('falls back to a generic title when the schedule has none', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);

    await presenter.show(deliveryRequest({ title: '' }));

    expect(requests[0]).toMatchObject({ title: '日程提醒' });
  });

  it('uses the reason-specific message for every trigger reason', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);
    const cases: readonly [ReminderDeliveryRequest['trigger']['reason'], string][] = [
      ['arrive_location', '您已进入目标地点附近，请及时处理。'],
      ['return_to_recorded_location', '您已回到记录地点附近，请及时处理。'],
      ['at_time', '已到提醒时间，请及时处理。'],
      ['before_start', '日程即将开始，请及时处理。'],
      ['snooze_expired', '延后提醒时间已到，请及时处理。'],
    ];

    for (const [reason] of cases) {
      await presenter.show(deliveryRequest({ trigger: { ...deliveryRequest().trigger, reason } }));
    }

    expect(requests.map((request) => request.message)).toEqual(cases.map(([, message]) => message));
  });

  it('notifies listeners with confirm when the confirm button is pressed', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);
    const listener = jest.fn();
    presenter.onAction(listener);

    await presenter.show(deliveryRequest());
    requests[0].buttons.find((button) => button.text === '确认')?.onPress?.();

    expect(listener).toHaveBeenCalledWith({ schedule_id: 'schedule-1', action: 'confirm' });
  });

  it('notifies listeners with snooze when the snooze button is pressed', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);
    const listener = jest.fn();
    presenter.onAction(listener);

    await presenter.show(deliveryRequest());
    requests[0].buttons.find((button) => button.text === '延后')?.onPress?.();

    expect(listener).toHaveBeenCalledWith({ schedule_id: 'schedule-1', action: 'snooze' });
  });

  it('stops notifying a listener once it has unsubscribed', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);
    const listener = jest.fn();
    const unsubscribe = presenter.onAction(listener);
    unsubscribe();

    await presenter.show(deliveryRequest());
    requests[0].buttons.find((button) => button.text === '确认')?.onPress?.();

    expect(listener).not.toHaveBeenCalled();
  });

  it('suppresses a pending action after hide() is called for that schedule', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);
    const listener = jest.fn();
    presenter.onAction(listener);

    await presenter.show(deliveryRequest());
    await presenter.hide('schedule-1');
    requests[0].buttons.find((button) => button.text === '确认')?.onPress?.();

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears suppression for a schedule the next time it is shown', async () => {
    const { dialog, requests } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);
    const listener = jest.fn();
    presenter.onAction(listener);

    await presenter.show(deliveryRequest());
    await presenter.hide('schedule-1');
    await presenter.show(deliveryRequest());
    requests[requests.length - 1].buttons.find((button) => button.text === '确认')?.onPress?.();

    expect(listener).toHaveBeenCalledWith({ schedule_id: 'schedule-1', action: 'confirm' });
  });

  it('hiding a schedule that is not currently visible is a no-op on the visible tracking', async () => {
    const { dialog } = createDialog();
    const presenter = new AlertReminderPresenter(dialog);

    await expect(presenter.hide('schedule-not-shown')).resolves.toBeUndefined();
  });
});
