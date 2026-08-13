import { AppRuntime } from '../orchestration/AppRuntime';
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

export type AppServices = {
  runtime: AppRuntime;
  reminder: ReminderApplicationPort;
  reminderPorts: ReminderApplicationDependencies;
  alertDialog: AlertDialogPort;
};

/** 提醒组合根：Alert 经端口注入；应用层仍为 mock。 */
export function createAppServices(): AppServices {
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

  return {
    runtime: new AppRuntime([
      {
        start: () => reminder.start(),
        stop: () => reminder.stop(),
      },
    ]),
    reminder,
    reminderPorts,
    alertDialog,
  };
}
