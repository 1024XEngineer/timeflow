import type { ReminderDisposition } from '../../domain';

export type ReminderDispositionSyncReceipt = {
  schedule_id: string;
  accepted: boolean;
};

/** 最终确认状态网络同步的可选回调；本处不实现网络请求。 */
export interface ReminderDispositionSyncPort {
  submitConfirmed(disposition: ReminderDisposition): Promise<ReminderDispositionSyncReceipt>;
}
