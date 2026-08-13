import { AppRuntime } from '../orchestration/AppRuntime';
import { createAuthRuntime, type AuthRuntime, type CreateAuthRuntimeOptions } from '../authRuntime';
import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
  AlertDialogPort,
} from '../../features/reminder/application/interfaces';
import {
  MockLocalScheduleReader,
  MockReminderApplication,
  MockReminderDispositionSync,
  MockReminderStateStore,
} from '../../features/reminder/data/local';
import { ExpoAudioPlayback } from '../../infrastructure/audio';
import { MockLocationMonitor } from '../../infrastructure/location';
import {
  MockPopup,
  MockReminderRecovery,
  MockReminderDelivery,
  MockSystemNotification,
  NativeAlarmScheduler,
  NativeDeviceCapability,
  ReactNativeAlertDialog,
  ReactNativeVibration,
} from '../../infrastructure/notifications';
import { IntervalTimeListener } from '../../infrastructure/time';
import { AlertReminderPresenter } from '../../features/reminder/presentation';
import { ScheduleViewStore } from '../../features/schedule/presentation';

export type AppServices = {
  auth: AuthRuntime;
  protectedClient: AuthRuntime['protectedClient'];
  runtime: AppRuntime;
  reminder: ReminderApplicationPort;
  reminderPorts: ReminderApplicationDependencies;
  alertDialog: AlertDialogPort;
  scheduleView: ScheduleViewStore;
  webSocketClient: AuthRuntime['webSocketClient'];
};

export interface CreateAppServicesOptions {
  readonly auth?: CreateAuthRuntimeOptions;
}

/** 应用唯一组合根：认证传输、功能服务、生命周期和账号内存清理在此接线。 */
export function createAppServices(options: CreateAppServicesOptions = {}): AppServices {
  const auth = createAuthRuntime(options.auth);
  const alertDialog = new ReactNativeAlertDialog();
  const reminderPorts: ReminderApplicationDependencies = {
    schedules: new MockLocalScheduleReader(),
    time: new IntervalTimeListener(),
    location: new MockLocationMonitor(),
    alarms: new NativeAlarmScheduler(),
    delivery: new MockReminderDelivery(),
    audio: new ExpoAudioPlayback(),
    device: new NativeDeviceCapability(),
    presenter: new AlertReminderPresenter(alertDialog),
    systemNotification: new MockSystemNotification(),
    popup: new MockPopup(),
    vibration: new ReactNativeVibration(),
    recovery: new MockReminderRecovery(),
    state: new MockReminderStateStore(),
    dispositionSync: new MockReminderDispositionSync(),
  };
  const reminder = new MockReminderApplication(reminderPorts);
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
    alertDialog,
    scheduleView,
    webSocketClient: auth.webSocketClient,
  };
}
