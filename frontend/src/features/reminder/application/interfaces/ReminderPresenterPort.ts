import type { ReminderDeliveryRequest } from '../../domain';

export type ReminderPresentationAction = 'confirm' | 'snooze';

export type ReminderPresentationReceipt = {
  presentation_id: string;
  visible: boolean;
};

/** 功能展示层的弹窗/悬浮层操作边界。 */
export interface ReminderPresenterPort {
  show(request: ReminderDeliveryRequest): Promise<ReminderPresentationReceipt>;
  hide(scheduleId: string): Promise<void>;
  onAction(
    listener: (event: { schedule_id: string; action: ReminderPresentationAction }) => void,
  ): () => void;
}
