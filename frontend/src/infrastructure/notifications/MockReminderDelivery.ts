import type { ReminderDeliveryPort } from '../../features/reminder/application/interfaces';
import type {
  ReminderDeliveryReceipt,
  ReminderDeliveryRequest,
} from '../../features/reminder/domain';

const MOCK_RECEIPT: ReminderDeliveryReceipt = {
  delivery_id: 'mock-delivery-001',
  schedule_id: 'mock-schedule-time-001',
  delivered_at: '2026-08-07T01:00:00.000Z',
  channels: ['system_notification'],
  used_fallback_audio: false,
};

/** 系统通知送达使用的固定通知边界。 */
export class MockReminderDelivery implements ReminderDeliveryPort {
  async deliver(request: ReminderDeliveryRequest): Promise<ReminderDeliveryReceipt> {
    return { ...MOCK_RECEIPT, schedule_id: request.schedule_id };
  }

  async dismiss(_scheduleId: string): Promise<void> {
    return Promise.resolve();
  }
}

export { MOCK_RECEIPT as MOCK_REMINDER_DELIVERY_RECEIPT };
