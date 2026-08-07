import type {
  ReminderDispositionSyncPort,
  ReminderDispositionSyncReceipt,
} from '../../application/interfaces';
import type { ReminderDisposition } from '../../domain';

/** 最终确认状态网络同步回调的模拟实现。 */
export class MockReminderDispositionSync implements ReminderDispositionSyncPort {
  async submitConfirmed(disposition: ReminderDisposition): Promise<ReminderDispositionSyncReceipt> {
    return {
      schedule_id: disposition.schedule_id,
      accepted: true,
    };
  }
}
