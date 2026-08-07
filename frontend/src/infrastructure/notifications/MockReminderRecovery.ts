import type {
  ReminderRecoveryPort,
  ReminderRecoveryReceipt,
} from '../../features/reminder/application/interfaces';

/** 固定重启恢复适配器，后续可替换为安卓启动接收器。 */
export class MockReminderRecovery implements ReminderRecoveryPort {
  async registerForRestart(): Promise<ReminderRecoveryReceipt> {
    return { registered: true, recovery_id: 'mock-recovery-001' };
  }

  async restoreAfterRestart(): Promise<ReminderRecoveryReceipt> {
    return { registered: true, recovery_id: 'mock-recovery-001' };
  }
}
