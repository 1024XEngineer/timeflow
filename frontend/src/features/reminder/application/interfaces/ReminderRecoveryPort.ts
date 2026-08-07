export type ReminderRecoveryReceipt = {
  registered: boolean;
  recovery_id: string;
};

/** 已注册本地监听在进程或后台重启后的恢复边界。 */
export interface ReminderRecoveryPort {
  registerForRestart(): Promise<ReminderRecoveryReceipt>;
  restoreAfterRestart(): Promise<ReminderRecoveryReceipt>;
}
