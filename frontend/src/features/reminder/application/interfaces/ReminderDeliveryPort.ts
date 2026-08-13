import type { ReminderDeliveryReceipt, ReminderDeliveryRequest } from '../../domain';

export type { ReminderDeliveryReceipt, ReminderDeliveryRequest };

/** 通过与平台无关的展示边界送达提醒。 */
export interface ReminderDeliveryPort {
  deliver(request: ReminderDeliveryRequest): Promise<ReminderDeliveryReceipt>;
  dismiss(scheduleId: string): Promise<void>;
}
