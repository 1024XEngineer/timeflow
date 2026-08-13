export type AlarmScheduleRequest = {
  schedule_id: string;
  trigger_at: string;
  title: string;
  exact: boolean;
};

export type AlarmScheduleReceipt = {
  alarm_id: string;
  schedule_id: string;
  /** false 表示未真正挂上系统闹钟，应用层不得当作成功注册。 */
  scheduled: boolean;
};

export type AlarmNativeEvent = {
  type: 'fired' | 'dismissed' | 'snoozed';
  schedule_id: string;
  alarm_id: string;
  title: string;
  at: string;
};

export type AlarmNativeDisposition = {
  schedule_id: string;
  alarm_id: string;
  state: 'pending' | 'confirmed' | 'snoozed';
  updated_at: string;
};

/** 原生闹钟映射边界；触发时间的选择留在应用层或领域层。 */
export interface AlarmSchedulerPort {
  schedule(request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt>;
  cancel(alarmId: string | null): Promise<{ cancelled: boolean }>;
  rebuild(requests: readonly AlarmScheduleRequest[]): Promise<readonly AlarmScheduleReceipt[]>;
  /** 停止正在响铃的原生界面/音频（尽力而为）。 */
  stopRinging?(): Promise<void>;
  /** 订阅原生响铃/停铃事件；无原生桥时可不实现。 */
  subscribe?(listener: (event: AlarmNativeEvent) => void): () => void;
  /** 拉取并清空进程外写入的处置状态（冷启动补水）。 */
  consumeNativeDispositions?(): Promise<readonly AlarmNativeDisposition[]>;
}
