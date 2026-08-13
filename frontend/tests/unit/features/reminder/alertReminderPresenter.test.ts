import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, type AlertButton } from 'react-native';

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
  let lastButtons: readonly AlertButton[] = [];

  beforeEach(() => {
    lastButtons = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      lastButtons = buttons ?? [];
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the reason-specific copy and default title fallback', async () => {
    const presenter = new AlertReminderPresenter();
    await presenter.show(request('at_time'));
    await presenter.show(request('before_start'));
    await presenter.show(request('arrive_location'));
    await presenter.show(request('return_to_recorded_location'));
    await presenter.show(request('snooze_expired'));
    await presenter.show(request('at_time', { title: '' }));

    expect(Alert.alert).toHaveBeenNthCalledWith(
      1,
      '晨会',
      '已到提醒时间，请及时处理。',
      expect.any(Array),
    );
    expect(Alert.alert).toHaveBeenNthCalledWith(
      2,
      '晨会',
      '日程即将开始，请及时处理。',
      expect.any(Array),
    );
    expect(Alert.alert).toHaveBeenNthCalledWith(
      3,
      '晨会',
      '您已进入目标地点附近，请及时处理。',
      expect.any(Array),
    );
    expect(Alert.alert).toHaveBeenNthCalledWith(
      4,
      '晨会',
      '您已回到记录地点附近，请及时处理。',
      expect.any(Array),
    );
    expect(Alert.alert).toHaveBeenNthCalledWith(
      5,
      '晨会',
      '延后提醒时间已到，请及时处理。',
      expect.any(Array),
    );
    expect(Alert.alert).toHaveBeenNthCalledWith(
      6,
      '日程提醒',
      '已到提醒时间，请及时处理。',
      expect.any(Array),
    );
  });

  it('emits confirm and snooze until hide suppresses further actions', async () => {
    const presenter = new AlertReminderPresenter();
    const listener = jest.fn();
    const unsubscribe = presenter.onAction(listener);

    await presenter.show(request('at_time'));
    lastButtons.find((button) => button.text === '确认')?.onPress?.();
    lastButtons.find((button) => button.text === '延后')?.onPress?.();
    expect(listener).toHaveBeenNthCalledWith(1, {
      schedule_id: 'schedule-time',
      action: 'confirm',
    });
    expect(listener).toHaveBeenNthCalledWith(2, { schedule_id: 'schedule-time', action: 'snooze' });

    await presenter.hide('schedule-time');
    lastButtons.find((button) => button.text === '确认')?.onPress?.();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
