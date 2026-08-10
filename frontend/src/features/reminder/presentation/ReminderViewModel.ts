import type { ReminderPresentationAction } from '../application/interfaces';
import type { ReminderDeliveryRequest } from '../domain';

/** 仅供视图使用的模型；界面悬浮层无需了解端口即可消费。 */
export type ReminderViewModel = {
  schedule_id: string;
  title: string;
  strength: ReminderDeliveryRequest['strength'];
  trigger_reason: ReminderDeliveryRequest['trigger']['reason'];
  visible: boolean;
  actions: readonly ReminderPresentationAction[];
};

export type ReminderActionHandler = (action: ReminderPresentationAction) => void;
