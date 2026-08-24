import type { AlarmSoundTier } from '../../domain/strengthDelivery';

export type AlarmScheduleRequest = {
  schedule_id: string;
  trigger_at: string;
  title: string;
  exact: boolean;
  /** 原生响铃时是否震动/出声/弹全屏止铃界面；由提醒强度换算而来。 */
  vibrate: boolean;
  sound_tier: AlarmSoundTier;
  full_screen: boolean;
  /** 仅 high 强度非空：设备 TTS 念的文案（标题 + 播报时间）；空则原生回退打包铃。 */
  speech_text?: string;
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

export type AlarmPresentationRequest = {
  alarm_id: string;
  schedule_id: string;
  title: string;
  vibrate: boolean;
  sound_tier: AlarmSoundTier;
  full_screen: boolean;
  /** 仅 high 强度非空：设备 TTS 念的文案（标题 + 播报时间）；空则原生回退打包铃。 */
  speech_text?: string;
};

export type AlarmPresentationReceipt = {
  alarm_id: string;
  schedule_id: string;
  presented: boolean;
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
  /** 只读取进程外写入的处置状态（冷启动补水），不清空原生缓冲区。 */
  peekNativeDispositions?(): Promise<readonly AlarmNativeDisposition[]>;
  /** 确认对应 schedule_id 已经在 JS 侧落盘成功，原生缓冲区才真正删除这批记录。 */
  ackNativeDispositions?(scheduleIds: readonly string[]): Promise<void>;
  /** 立即交给原生全局响铃页；不可用时返回 presented=false，由上层回退。 */
  presentNow?(request: AlarmPresentationRequest): Promise<AlarmPresentationReceipt>;
}
