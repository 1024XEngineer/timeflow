import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ExpoSystemNotification } from '../../../../src/infrastructure/notifications/ExpoSystemNotification';

/**
 * expo-notifications 的动态 import() 在这个 Jest 环境下天然会抛错（没有
 * --experimental-vm-modules），jest.mock('expo-notifications', ...) 拦不住它——见
 * ExpoSystemNotification.ts 构造函数上新加的注入口子。这里直接注入一个假的
 * loadNotificationsModule，绕开真的动态 import，测真正的展示/取消逻辑。
 *
 * ExpoSystemNotification.ts 用一个模块级变量 channelReady 缓存"频道已建好"这件事，
 * 所以每个用例都要用 jest.resetModules() + require() 拿一份全新的模块实例，不然前一条
 * 用例建好的频道会让后一条用例误判成"已经建过频道，不用再调 setNotificationChannelAsync"。
 * （用 require 而不是 import()：这个 Jest 环境本身不支持运行时动态 import()。）
 */
describe('ExpoSystemNotification (fake native notifications module injected)', () => {
  const setNotificationChannelAsync = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const setNotificationHandler = jest.fn();
  const scheduleNotificationAsync = jest.fn<() => Promise<string>>().mockResolvedValue('id');
  const dismissNotificationAsync = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const cancelScheduledNotificationAsync = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);

  function loadNotificationsModule() {
    return Promise.resolve({
      AndroidImportance: { DEFAULT: 3 },
      setNotificationChannelAsync,
      setNotificationHandler,
      scheduleNotificationAsync,
      dismissNotificationAsync,
      cancelScheduledNotificationAsync,
    } as unknown as typeof import('expo-notifications'));
  }

  function freshExpoSystemNotification(): ExpoSystemNotification {
    let FreshClass: typeof ExpoSystemNotification | undefined;
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const moduleExports =
        require('../../../../src/infrastructure/notifications/ExpoSystemNotification') as {
          ExpoSystemNotification: typeof ExpoSystemNotification;
        };
      /* eslint-enable @typescript-eslint/no-require-imports */
      FreshClass = moduleExports.ExpoSystemNotification;
    });
    return new FreshClass!(loadNotificationsModule);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setNotificationChannelAsync.mockResolvedValue(undefined);
    scheduleNotificationAsync.mockResolvedValue('id');
    dismissNotificationAsync.mockResolvedValue(undefined);
    cancelScheduledNotificationAsync.mockResolvedValue(undefined);
  });

  it('returns shown: false without touching the module when it fails to load', async () => {
    const notification = new ExpoSystemNotification(() => Promise.resolve(null));
    await expect(
      notification.show({ notification_id: 'n1', title: '标题', body: '内容' }),
    ).resolves.toEqual({ notification_id: 'n1', shown: false });
    expect(setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('creates the Android channel once, schedules the notification, and reports shown: true', async () => {
    const notification = freshExpoSystemNotification();
    const receipt = await notification.show({ notification_id: 'n1', title: '标题', body: '内容' });

    expect(receipt).toEqual({ notification_id: 'n1', shown: true });
    expect(setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(setNotificationChannelAsync).toHaveBeenCalledWith(
      'timeflow-reminders-quiet',
      expect.objectContaining({ name: '日程提醒（静音）', sound: null }),
    );
    expect(scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'n1',
      content: { title: '标题', body: '内容', sound: false },
      trigger: { channelId: 'timeflow-reminders-quiet' },
    });
  });

  it('installs a foreground handler that shows the banner/list without sound or badge', async () => {
    const notification = freshExpoSystemNotification();
    await notification.show({ notification_id: 'n1', title: '标题', body: '内容' });

    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
    const { handleNotification } = setNotificationHandler.mock.calls[0][0] as {
      handleNotification: () => Promise<Record<string, boolean>>;
    };
    await expect(handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('reuses the cached channel setup across repeated calls instead of recreating it', async () => {
    const notification = freshExpoSystemNotification();
    await notification.show({ notification_id: 'n1', title: 'a', body: 'a' });
    await notification.show({ notification_id: 'n2', title: 'b', body: 'b' });

    expect(setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(2);
  });

  it('clears the cached channel setup after a failure so the next call retries', async () => {
    const notification = freshExpoSystemNotification();
    setNotificationChannelAsync.mockRejectedValueOnce(new Error('channel setup failed'));

    await expect(
      notification.show({ notification_id: 'n1', title: 'a', body: 'a' }),
    ).rejects.toThrow('channel setup failed');
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();

    await expect(
      notification.show({ notification_id: 'n2', title: 'b', body: 'b' }),
    ).resolves.toEqual({ notification_id: 'n2', shown: true });
    expect(setNotificationChannelAsync).toHaveBeenCalledTimes(2);
  });

  it('cancel is a no-op when the module fails to load', async () => {
    const notification = new ExpoSystemNotification(() => Promise.resolve(null));
    await expect(notification.cancel('n1')).resolves.toBeUndefined();
    expect(dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it('cancel dismisses and unschedules the notification, swallowing either failure', async () => {
    const notification = freshExpoSystemNotification();
    await notification.cancel('n1');
    expect(dismissNotificationAsync).toHaveBeenCalledWith('n1');
    expect(cancelScheduledNotificationAsync).toHaveBeenCalledWith('n1');

    dismissNotificationAsync.mockRejectedValueOnce(new Error('already dismissed'));
    cancelScheduledNotificationAsync.mockRejectedValueOnce(new Error('already cancelled'));
    await expect(notification.cancel('n2')).resolves.toBeUndefined();
  });
});
