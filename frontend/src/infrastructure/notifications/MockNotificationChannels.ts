import type {
  AlertDialogPort,
  AlertDialogRequest,
  PopupPort,
  PopupReceipt,
  PopupRequest,
  SystemNotificationPort,
  SystemNotificationReceipt,
  SystemNotificationRequest,
  VibrationPort,
} from '../../features/reminder/application/interfaces';

export class MockSystemNotification implements SystemNotificationPort {
  async show(request: SystemNotificationRequest): Promise<SystemNotificationReceipt> {
    return { notification_id: request.notification_id, shown: true };
  }

  async cancel(_notificationId: string): Promise<void> {
    return Promise.resolve();
  }
}

export class MockPopup implements PopupPort {
  async show(request: PopupRequest): Promise<PopupReceipt> {
    return { popup_id: request.popup_id, visible: true };
  }

  async dismiss(_popupId: string): Promise<void> {
    return Promise.resolve();
  }
}

export class MockVibration implements VibrationPort {
  async vibrate(): Promise<void> {
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    return Promise.resolve();
  }
}

export class MockAlertDialog implements AlertDialogPort {
  async show(_request: AlertDialogRequest): Promise<void> {
    return Promise.resolve();
  }
}
