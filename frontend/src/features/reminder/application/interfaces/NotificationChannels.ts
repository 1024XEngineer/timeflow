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

export type AlertDialogButton = {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

export type AlertDialogRequest = {
  title: string;
  message: string;
  buttons: readonly AlertDialogButton[];
};

/** 系统确认/选择对话框；由 infrastructure 适配，presentation 不直接依赖 RN Alert。 */
export interface AlertDialogPort {
  show(request: AlertDialogRequest): Promise<void>;
}
