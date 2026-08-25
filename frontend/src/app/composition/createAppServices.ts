import { AppRuntime } from '../orchestration/AppRuntime';
import { createAuthRuntime, type AuthRuntime, type CreateAuthRuntimeOptions } from '../authRuntime';
import type {
  AlertDialogPort,
  ReminderApplicationDependencies,
  ReminderApplicationPort,
} from '../../features/reminder/application/interfaces';
import {
  LocalReminderApplication,
  ReminderGuardCoordinator,
} from '../../features/reminder/application';
import {
  LocalReminderDelivery,
  LocalReminderRecovery,
  NoopPopup,
  SqliteLocalScheduleReader,
  SqliteReminderStateStore,
} from '../../features/reminder/data/local';
import { ReminderDispositionHttpSync } from '../../features/reminder/data/http';
import { AlertReminderPresenter } from '../../features/reminder/presentation';
import { ExpoAudioPlayback } from '../../infrastructure/audio';
import { ExpoLocationMonitor } from '../../infrastructure/location';
import {
  ExpoSystemNotification,
  NativeAlarmScheduler,
  NativeDeviceCapability,
  ReactNativeAlertDialog,
  ReactNativeVibration,
} from '../../infrastructure/notifications';
import { IntervalTimeListener } from '../../infrastructure/time';
import { ScheduleViewStore } from '../../features/schedule/presentation';

export interface CreateAppServicesOptions {
  readonly auth?: CreateAuthRuntimeOptions;
  readonly schedules?: SqliteLocalScheduleReader;
  readonly overrides?: Partial<ReminderApplicationDependencies>;
}

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
  alertDialog: AlertDialogPort;
};

/** 应用唯一组合根：认证传输、功能服务、生命周期和账号内存清理在此接线。 */
export function createAppServices(options: CreateAppServicesOptions = {}): AppServices {
  const auth = createAuthRuntime(options.auth);
  const alertDialog = new ReactNativeAlertDialog();
  const schedules = options.schedules ?? new SqliteLocalScheduleReader();
  const reminderState = new SqliteReminderStateStore();
  const presenter =
    (options.overrides?.presenter as AlertReminderPresenter | undefined) ??
    new AlertReminderPresenter(alertDialog);

  const {
    schedules: _ignoredSchedules,
    presenter: _ignoredPresenter,
    ...restOverrides
  } = options.overrides ?? {};

  const reminderPorts: ReminderApplicationDependencies = {
    time: new IntervalTimeListener(),
    location: new ExpoLocationMonitor(),
    alarms: new NativeAlarmScheduler(),
    delivery: new LocalReminderDelivery(),
    audio: new ExpoAudioPlayback(),
    device: new NativeDeviceCapability(),
    systemNotification: new ExpoSystemNotification(),
    popup: new NoopPopup(),
    vibration: new ReactNativeVibration(),
    recovery: new LocalReminderRecovery(),
    state: reminderState,
    dispositionSync: new ReminderDispositionHttpSync(auth.protectedClient),
    ...restOverrides,
    schedules,
    presenter,
  };

  const reminder = new LocalReminderApplication(reminderPorts);
  const reminderGuard = new ReminderGuardCoordinator({
    schedules,
    handleLocation: (sample) => reminder.handleLocation(sample),
  });
  const scheduleView = new ScheduleViewStore();
  const runtime = new AppRuntime([
    {
      start: () => reminder.start(),
      stop: () => reminder.stop(),
    },
    {
      start: () => reminderGuard.start(),
      stop: () => reminderGuard.stop(),
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
    alertDialog,
  };
}
