import { AppRuntime } from '../orchestration/AppRuntime';
import { createAuthRuntime, type AuthRuntime, type CreateAuthRuntimeOptions } from '../authRuntime';
import type {
  AlertDialogPort,
  ReminderApplicationDependencies,
  ReminderApplicationPort,
} from '../../features/reminder/application/interfaces';
import { LocalReminderApplication } from '../../features/reminder/application';
import {
  LocalReminderDelivery,
  LocalReminderDispositionSync,
  LocalReminderRecovery,
  NoopPopup,
  SqliteLocalScheduleReader,
  SqliteReminderStateStore,
} from '../../features/reminder/data/local';
import { AlertReminderPresenter } from '../../features/reminder/presentation';
import { ExpoAudioPlayback } from '../../infrastructure/audio';
// NativeLocationMonitor（百度定位 SDK）保留在仓库里没删，只是这次没接进来——现在用的
// 是 ExpoLocationMonitor（系统原生地理围栏），不依赖百度控制台那个 AK 注册。百度那个
// Key 配置好之后如果想切回去，把下面这行 import 和 reminderPorts.location 换回来就行。
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
  scheduleView: ScheduleViewStore;
  webSocketClient: AuthRuntime['webSocketClient'];
  /** 需要 attach()/detach()/refresh() 时用这些具体类型；LocalReminderApplication 只经 reminderPorts 访问端口接口。 */
  schedules: SqliteLocalScheduleReader;
  reminderState: SqliteReminderStateStore;
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
    dispositionSync: new LocalReminderDispositionSync(),
    ...restOverrides,
    schedules,
    presenter,
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
    scheduleView,
    webSocketClient: auth.webSocketClient,
    schedules,
    reminderState,
    alertDialog,
  };
}
