import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Notifications from 'expo-notifications';

import { ExpoSystemNotification } from '../../../../src/infrastructure/notifications/ExpoSystemNotification';

jest.mock('expo-notifications', () => ({
  __esModule: true,
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn(async () => undefined),
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'scheduled'),
  dismissNotificationAsync: jest.fn(async () => undefined),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
}));

describe('ExpoSystemNotification', () => {
  beforeEach(() => {
    (Notifications.setNotificationChannelAsync as jest.Mock).mockClear();
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();
    (Notifications.dismissNotificationAsync as jest.Mock).mockClear();
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockClear();
  });

  it('creates the Android channel and shows a notification', async () => {
    const port = new ExpoSystemNotification();
    await expect(
      port.show({ notification_id: 'n1', title: '晨会', body: '会议室' }),
    ).resolves.toEqual({ notification_id: 'n1', shown: true });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'n1' }),
    );
  });

  it('dismisses and cancels by notification id', async () => {
    const port = new ExpoSystemNotification();
    await port.cancel('n1');
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('n1');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('n1');
  });
});
