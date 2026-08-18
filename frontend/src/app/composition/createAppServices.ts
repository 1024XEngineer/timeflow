import { AppRuntime } from '../orchestration/AppRuntime';
import { createAuthRuntime, type AuthRuntime, type CreateAuthRuntimeOptions } from '../authRuntime';
import { isMockMode } from '../previewMode';
import { createMockAuthAccess } from '../../features/auth/data/createMockAuthAccess';
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
import { MockReminderPresenter } from '../../features/reminder/presentation';
import { ScheduleViewStore } from '../../features/schedule/presentation';
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
  NativeAlarmScheduler,
  NativeDeviceCapability,
} from '../../infrastructure/notifications';
import { MockTimeListener } from '../../shared/time';

export type AppServices = {
  auth: AuthRuntime;
  protectedClient: AuthRuntime['protectedClient'];
  runtime: AppRuntime;
  reminder: ReminderApplicationPort;
  reminderPorts: ReminderApplicationDependencies;
  scheduleView: ScheduleViewStore;
  webSocketClient: AuthRuntime['webSocketClient'];
};

export interface CreateAppServicesOptions {
  readonly auth?: CreateAuthRuntimeOptions;
}

/** 应用唯一组合根：认证传输、功能服务、生命周期和账号内存清理在此接线。 */
export function createAppServices(options: CreateAppServicesOptions = {}): AppServices {
  const mock = isMockMode();
  const auth = createAuthRuntime({
    ...options.auth,
    ...(mock && options.auth?.authAccess === undefined
      ? { authAccess: createMockAuthAccess() }
      : {}),
  });
  const reminderPorts: ReminderApplicationDependencies = {
    schedules: new MockLocalScheduleReader(),
    time: new MockTimeListener(),
    location: new MockLocationMonitor(),
    alarms: mock ? new MockAlarmScheduler() : new NativeAlarmScheduler(),
    delivery: new MockReminderDelivery(),
    audio: new MockAudioPlayback(),
    device: mock ? new MockDeviceCapability() : new NativeDeviceCapability(),
    presenter: new MockReminderPresenter(),
    systemNotification: new MockSystemNotification(),
    popup: new MockPopup(),
    vibration: new MockVibration(),
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
    scheduleView,
    webSocketClient: auth.webSocketClient,
  };
}
