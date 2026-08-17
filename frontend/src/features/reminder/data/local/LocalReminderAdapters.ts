import type {
  PopupPort,
  PopupReceipt,
  PopupRequest,
  ReminderDeliveryPort,
  ReminderDeliveryReceipt,
  ReminderDeliveryRequest,
  ReminderDispositionSyncPort,
  ReminderDispositionSyncReceipt,
  ReminderRecoveryPort,
  ReminderRecoveryReceipt,
  ReminderConfirmedDisposition,
} from '../../application/interfaces';

/** 送达记账：展示由 systemNotification / presenter 完成，此处只返回回执。 */
export class LocalReminderDelivery implements ReminderDeliveryPort {
  async deliver(request: ReminderDeliveryRequest): Promise<ReminderDeliveryReceipt> {
    return {
      delivery_id: `delivery-${request.schedule_id}-${Date.now()}`,
      schedule_id: request.schedule_id,
      delivered_at: new Date().toISOString(),
      channels: [],
      used_fallback_audio: false,
    };
  }

  async dismiss(_scheduleId: string): Promise<void> {
    return Promise.resolve();
  }
}

/** 弹窗通道占位：提醒页由 ReminderPresenter 承接。 */
export class NoopPopup implements PopupPort {
  async show(request: PopupRequest): Promise<PopupReceipt> {
    return { popup_id: request.popup_id, visible: false };
  }

  async dismiss(_popupId: string): Promise<void> {
    return Promise.resolve();
  }
}


/** 重启恢复占位：后续可接开机广播 / 精确闹钟重挂。 */
export class LocalReminderRecovery implements ReminderRecoveryPort {
  async registerForRestart(): Promise<ReminderRecoveryReceipt> {
    return { registered: true, recovery_id: `recovery-${Date.now()}` };
  }

  async restoreAfterRestart(): Promise<ReminderRecoveryReceipt> {
    return { registered: true, recovery_id: `recovery-${Date.now()}` };
  }
}

/** 确认态本地受理：无网络时也返回 accepted，供后续 sync 替换。 */
export class LocalReminderDispositionSync implements ReminderDispositionSyncPort {
  async submitConfirmed(
    disposition: ReminderConfirmedDisposition,
  ): Promise<ReminderDispositionSyncReceipt> {
    return {
      schedule_id: disposition.schedule_id,
      accepted: true,
    };
  }
}
