import type { ReminderDisposition, ReminderDispositionState } from '../../domain';

export type ReminderDispositionSyncReceipt = {
  schedule_id: string;
  accepted: boolean;
};

/**
 * 仅表示已确认的处置，与电汇合同 `ReminderDispositionSyncRequest` 对齐。
 * `submitConfirmed` 不得接收 pending / snoozed。
 */
export type ReminderConfirmedDisposition = Omit<ReminderDisposition, 'state' | 'snoozed_until'> & {
  state: Extract<ReminderDispositionState, 'confirmed'>;
  snoozed_until: null;
};

/** 最终确认状态网络同步的可选回调；本处不实现网络请求。 */
export interface ReminderDispositionSyncPort {
  submitConfirmed(
    disposition: ReminderConfirmedDisposition,
  ): Promise<ReminderDispositionSyncReceipt>;
}
