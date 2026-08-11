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
};

/**
 * 贪睡必须且只能提供一种目标时刻表达：绝对时间或相对分钟。
 * 两种字段互斥，避免实现层自行决定优先级，也禁止无目标时刻的请求。
 */
export type ReminderSnoozeRequest =
  | {
      schedule_id: string;
      snooze_until: string;
      snooze_minutes?: never;
    }
  | {
      schedule_id: string;
      snooze_minutes: number;
      snooze_until?: never;
    };

export type ReminderApplicationResult = {
  accepted: boolean;
  schedule_id: string;
  disposition: ReminderDisposition | null;
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
}
