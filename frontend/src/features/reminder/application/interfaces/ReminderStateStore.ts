import type { ReminderDisposition, ReminderRuntimeState } from '../../domain';

/** 仅保存设备运行状态；后续实现可以接入本地数据库。 */
export interface ReminderStateStore {
  read(scheduleId: string): Promise<ReminderRuntimeState | null>;
  write(scheduleId: string, state: ReminderRuntimeState): Promise<void>;
  setDisposition(scheduleId: string, disposition: ReminderDisposition): Promise<void>;
}
