import { AppRuntime } from '../orchestration/AppRuntime';
import type {
  ReminderApplicationDependencies,
  ReminderApplicationPort,
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
  ReactNativeVibration,
} from '../../infrastructure/notifications';
import { IntervalTimeListener } from '../../shared/time';
import { MockReminderPresenter } from '../../features/reminder/presentation';

export type AppServices = {
  runtime: AppRuntime;
  reminder: ReminderApplicationPort;
  reminderPorts: ReminderApplicationDependencies;
};

/** 提醒组合根：时间/音频/震动已接原生适配器；presenter 仍为 mock。 */
export function createAppServices(): AppServices {
  const reminderPorts: ReminderApplicationDependencies = {
    schedules: new MockLocalScheduleReader(),
    time: new IntervalTimeListener(),
    location: new MockLocationMonitor(),
    alarms: new NativeAlarmScheduler(),
    delivery: new MockReminderDelivery(),
    audio: new ExpoAudioPlayback(),
    device: new NativeDeviceCapability(),
    presenter: new MockReminderPresenter(),
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
  };
}
