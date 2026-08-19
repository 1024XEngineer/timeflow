import type {
  SystemNotificationPort,
  SystemNotificationReceipt,
  SystemNotificationRequest,
} from '../../features/reminder/application/interfaces';

type NotificationsModule = typeof import('expo-notifications');

let channelReady: Promise<void> | null = null;

async function loadNotifications(): Promise<NotificationsModule | null> {
  try {
    return await import('expo-notifications');
  } catch {
    return null;
  }
}

async function ensureAndroidChannel(Notifications: NotificationsModule): Promise<void> {
  if (channelReady != null) {
    await channelReady;
    return;
  }
  channelReady = (async () => {
    await Notifications.setNotificationChannelAsync('timeflow-reminders', {
      name: '日程提醒',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180],
      lightColor: '#D7F36A',
    });
  })().catch((error) => {
    // 失败别永久缓存住：清掉 channelReady，让下一条提醒重试，而不是这次失败
    // 之后整个 App 生命周期里 show() 都跟着抛。
    channelReady = null;
    throw error;
  });
  await channelReady;
}

/** 基于 expo-notifications 的轻度提醒系统通知。 */
export class ExpoSystemNotification implements SystemNotificationPort {
  /** 默认走真实的动态 import；测试注入一个假实现，绕开 expo-notifications 这个原生模块。 */
  constructor(
    private readonly loadNotificationsModule: () => Promise<NotificationsModule | null> = loadNotifications,
  ) {}

  async show(request: SystemNotificationRequest): Promise<SystemNotificationReceipt> {
    const Notifications = await this.loadNotificationsModule();
    if (Notifications == null) {
      return { notification_id: request.notification_id, shown: false };
    }

    await ensureAndroidChannel(Notifications);
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    await Notifications.scheduleNotificationAsync({
      identifier: request.notification_id,
      content: {
        title: request.title,
        body: request.body,
        sound: false,
      },
      trigger: null,
    });

    return { notification_id: request.notification_id, shown: true };
  }

  async cancel(notificationId: string): Promise<void> {
    const Notifications = await this.loadNotificationsModule();
    if (Notifications == null) return;
    await Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    await Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined);
  }
}
