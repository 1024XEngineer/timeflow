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
  })();
  await channelReady;
}

/** 基于 expo-notifications 的轻度提醒系统通知。 */
export class ExpoSystemNotification implements SystemNotificationPort {
  async show(request: SystemNotificationRequest): Promise<SystemNotificationReceipt> {
    const Notifications = await loadNotifications();
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
    const Notifications = await loadNotifications();
    if (Notifications == null) return;
    await Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    await Notifications.cancelScheduledNotificationAsync(notificationId).catch(() => undefined);
  }
}
