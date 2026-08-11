export type SystemNotificationRequest = {
  notification_id: string;
  title: string;
  body: string;
};

export type SystemNotificationReceipt = {
  notification_id: string;
  shown: boolean;
};

export interface SystemNotificationPort {
  show(request: SystemNotificationRequest): Promise<SystemNotificationReceipt>;
  cancel(notificationId: string): Promise<void>;
}

export type PopupRequest = {
  popup_id: string;
  title: string;
  body: string;
};

export type PopupReceipt = {
  popup_id: string;
  visible: boolean;
};

export interface PopupPort {
  show(request: PopupRequest): Promise<PopupReceipt>;
  dismiss(popupId: string): Promise<void>;
}

export interface VibrationPort {
  vibrate(): Promise<void>;
  stop(): Promise<void>;
}
