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
import { MockAudioPlayback } from '../../infrastructure/audio';
import { MockLocationMonitor } from '../../infrastructure/location';
import {
  MockAlarmScheduler,
  MockDeviceCapability,
  MockPopup,
  MockReminderRecovery,
  MockReminderDelivery,
  MockSystemNotification,
  MockVibration,
} from '../../infrastructure/notifications';
import { MockTimeListener } from '../../shared/time';
import { MockReminderPresenter } from '../../features/reminder/presentation';

export type AppServices = {
  runtime: AppRuntime;
  reminder: ReminderApplicationPort;
  reminderPorts: ReminderApplicationDependencies;
};

/** 提醒端口的组合根；当前所有具体适配器都是确定性的模拟实现。 */
export function createAppServices(): AppServices {
  const reminderPorts: ReminderApplicationDependencies = {
    schedules: new MockLocalScheduleReader(),
    time: new MockTimeListener(),
    location: new MockLocationMonitor(),
    alarms: new MockAlarmScheduler(),
    delivery: new MockReminderDelivery(),
    audio: new MockAudioPlayback(),
    device: new MockDeviceCapability(),
    presenter: new MockReminderPresenter(),
    systemNotification: new MockSystemNotification(),
    popup: new MockPopup(),
    vibration: new MockVibration(),
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
