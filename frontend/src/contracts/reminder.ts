/**
 * 日程快照和提醒确认消息共用的线上提醒字段。
 *
 * 功能领域层会用更丰富的本地运行时类型重新导出相同词汇。本文件只保留
 * 协议结构，数据适配器无需反向依赖提醒功能。
 */
export type ReminderType =
  'at_time' | 'before_start' | 'arrive_location' | 'return_to_recorded_location';

export type ReminderStrength = 'low' | 'medium' | 'high';
export type ReminderDispositionState = 'pending' | 'confirmed' | 'snoozed';
export type ReminderSyncStatus = 'pending' | 'synced';

/** 为兼容旧日程接口而保留的粗粒度分类。 */
export type ReminderKind = 'time' | 'location';

/** 传给本地通知、弹窗、震动或音频适配器的数据。 */
export type ReminderDelivery = {
  reminder_id: string;
  schedule_id: string;
  /** 旧接口使用的粗粒度分类。 */
  kind: ReminderKind;
  /** 当前架构使用的精确提醒类型。 */
  reminder_type?: ReminderType;
  strength?: ReminderStrength;
  title: string;
  triggered_at: string;
};

/** 本地地点监听适配器消费的定位观测数据。 */
export type LocationObservation = {
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  observed_at: string;
};

/** 最终确认提醒处置状态的协议载荷。 */
export type ReminderDispositionSyncRequest = {
  schedule_id: string;
  disposition_state: Extract<ReminderDispositionState, 'confirmed'>;
};

export type ReminderDispositionSyncResponse = {
  schedule_id: string;
  disposition_state: Extract<ReminderDispositionState, 'confirmed'>;
  sync_status: Extract<ReminderSyncStatus, 'synced'>;
};
