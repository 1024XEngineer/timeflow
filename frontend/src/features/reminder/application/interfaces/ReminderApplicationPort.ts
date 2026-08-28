import type { ClientTelemetryPort } from '../../../../shared/observability';
import type {
  LocalReminderSchedule,
  LocationSample,
  ReminderDeliveryReceipt,
  ReminderDisposition,
  ReminderRegistration,
  ReminderTrigger,
} from '../../domain';

export type ReminderApplicationDependencies = {
  schedules: import('./LocalScheduleReader').LocalScheduleReader;
  time: import('./TimeListenerPort').TimeListenerPort;
  location: import('./LocationMonitorPort').LocationMonitorPort;
  alarms: import('./AlarmSchedulerPort').AlarmSchedulerPort;
  delivery: import('./ReminderDeliveryPort').ReminderDeliveryPort;
  audio: import('./AudioPlaybackPort').AudioPlaybackPort;
  device: import('./DeviceCapabilityPort').DeviceCapabilityPort;
  presenter: import('./ReminderPresenterPort').ReminderPresenterPort;
  systemNotification: import('./NotificationChannels').SystemNotificationPort;
  popup: import('./NotificationChannels').PopupPort;
  vibration: import('./NotificationChannels').VibrationPort;
  recovery: import('./ReminderRecoveryPort').ReminderRecoveryPort;
  state: import('./ReminderStateStore').ReminderStateStore;
  dispositionSync: import('./ReminderDispositionSyncPort').ReminderDispositionSyncPort;
  /** 客户端埋点；缺省为 NoOp，单测不用接 Sentry。 */
  telemetry?: ClientTelemetryPort;
  /** 前后台状态；缺省则 app_state=unknown，不把送达标成回前台补响。 */
  lifecycle?: import('./ReminderLifecyclePort').ReminderLifecyclePort;
};

export type ReminderSnoozeRequest = {
  schedule_id: string;
  snooze_until: string | null;
  snooze_minutes?: number | null;
};

export type ReminderApplicationResult = {
  accepted: boolean;
  schedule_id: string;
  disposition: ReminderDisposition | null;
};

/** 单条日程刚注册（非批量 rebuild）时，发现缺少的权限。 */
export type ReminderPermissionBlockedEvent = {
  schedule_id: string;
  missing: readonly import('./DeviceCapabilityPort').DevicePermission[];
};

/** 供应用编排层和展示层调用的用例接口。 */
export interface ReminderApplicationPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  register(schedule: LocalReminderSchedule): Promise<ReminderRegistration>;
  rebuild(): Promise<readonly ReminderRegistration[]>;
  handleTime(tick: { observed_at: string }): Promise<void>;
  handleLocation(sample: LocationSample): Promise<void>;
  deliver(trigger: ReminderTrigger): Promise<ReminderDeliveryReceipt>;
  confirm(scheduleId: string, confirmedAt: string): Promise<ReminderApplicationResult>;
  snooze(request: ReminderSnoozeRequest): Promise<ReminderApplicationResult>;
  /**
   * 订阅"单条日程刚注册、但缺权限导致挂不上闹钟/围栏"事件；只在 register()
   * 触发的增量注册时发，rebuild() 的批量重挂不发（否则每次 rebuild 都会给老日程
   * 重弹一遍，见调用方 registerInternal/rebuildInternal 的路径区分）。
   */
  onPermissionBlocked(listener: (event: ReminderPermissionBlockedEvent) => void): () => void;
  /**
   * 订阅"某条日程被确认"事件——确认只写本地 SQLite，不经过日历页读取的
   * ScheduleClientService，日历页不知道要重取，地点提醒会一直挂着直到重启。
   */
  onScheduleConfirmed(listener: () => void): () => void;
}
