export type AlarmScheduleRequest = {
  schedule_id: string;
  trigger_at: string;
  title: string;
  exact: boolean;
};

export type AlarmScheduleReceipt = {
  alarm_id: string;
  schedule_id: string;
};

/** 原生闹钟映射边界；触发时间的选择留在应用层或领域层。 */
export interface AlarmSchedulerPort {
  schedule(request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt>;
  cancel(alarmId: string | null): Promise<{ cancelled: boolean }>;
  rebuild(requests: readonly AlarmScheduleRequest[]): Promise<readonly AlarmScheduleReceipt[]>;
}
