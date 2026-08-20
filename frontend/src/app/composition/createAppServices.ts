import { AppRuntime } from '../orchestration/AppRuntime';
import { createAuthRuntime, type AuthRuntime, type CreateAuthRuntimeOptions } from '../authRuntime';
import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
} from '../../features/reminder/application/interfaces';
import { LocalReminderApplication } from '../../features/reminder/application';
import {
  LocalReminderDispositionSync,
  SqliteLocalScheduleReader,
  SqliteReminderStateStore,
} from '../../features/reminder/data/local';
import { ExpoAudioPlayback } from '../../infrastructure/audio';
import { ExpoLocationMonitor } from '../../infrastructure/location';
import {
  MockPopup,
  MockReminderRecovery,
  MockReminderDelivery,
  MockSystemNotification,
  MockVibration,
  NativeAlarmScheduler,
  NativeDeviceCapability,
} from '../../infrastructure/notifications';
import { IntervalTimeListener } from '../../infrastructure/time';
import { MockReminderPresenter } from '../../features/reminder/presentation';
import { ScheduleViewStore } from '../../features/schedule/presentation';

export type AppServices = {
  auth: AuthRuntime;
  protectedClient: AuthRuntime['protectedClient'];
  runtime: AppRuntime;
  reminder: ReminderApplicationPort;
  reminderPorts: ReminderApplicationDependencies;
  reminderState: SqliteReminderStateStore;
  scheduleView: ScheduleViewStore;
  schedules: SqliteLocalScheduleReader;
  webSocketClient: AuthRuntime['webSocketClient'];
};

export interface CreateAppServicesOptions {
  readonly auth?: CreateAuthRuntimeOptions;
}

/** 应用唯一组合根：认证传输、功能服务、生命周期和账号内存清理在此接线。 */
export function createAppServices(options: CreateAppServicesOptions = {}): AppServices {
  const auth = createAuthRuntime(options.auth);
  const schedules = new SqliteLocalScheduleReader();
  const reminderState = new SqliteReminderStateStore();
  const reminderPorts: ReminderApplicationDependencies = {
    schedules,
    time: new IntervalTimeListener(),
    location: new ExpoLocationMonitor(),
    alarms: new NativeAlarmScheduler(),
    delivery: new MockReminderDelivery(),
    audio: new ExpoAudioPlayback(),
    device: new NativeDeviceCapability(),
    presenter: new MockReminderPresenter(),
    systemNotification: new MockSystemNotification(),
    popup: new MockPopup(),
    vibration: new MockVibration(),
    recovery: new MockReminderRecovery(),
    state: reminderState,
    dispositionSync: new LocalReminderDispositionSync(),
  };
  const reminder = new LocalReminderApplication(reminderPorts);
  const scheduleView = new ScheduleViewStore();
  const runtime = new AppRuntime([
    {
      start: () => reminder.start(),
      stop: () => reminder.stop(),
    },
  ]);

  auth.accountStateCleaners.register('schedule-view', () => scheduleView.clear());
  auth.accountStateCleaners.register('reminder-runtime', () => runtime.stop());

  return {
    auth,
    protectedClient: auth.protectedClient,
    runtime,
    reminder,
    reminderPorts,
    reminderState,
    scheduleView,
    schedules,
    webSocketClient: auth.webSocketClient,
  };
}
