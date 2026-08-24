import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AssistantContinuousConversationService } from '../features/assistant/application/AssistantContinuousConversationService';
import { AssistantConversationService } from '../features/assistant/application/AssistantConversationService';
import type { AssistantApplicationDependencies } from '../features/assistant/application/interfaces/AssistantApplicationPort';
import { ExpoAudioCapture } from '../features/assistant/data/audio/ExpoAudioCapture';
import { ExpoAudioPlayback } from '../features/assistant/data/audio/ExpoAudioPlayback';
import { AuthenticatedVoiceTransport } from '../features/assistant/data/websocket/AuthenticatedVoiceTransport';
import { LocalScheduleWriter } from '../features/assistant/data/local/LocalScheduleWriter';
import { useAuth } from '../features/auth/presentation/AuthProvider';
import type {
  AlertDialogPort,
  DeviceCapabilityPort,
  DevicePermission,
  ReminderApplicationPort,
  SqliteLocalScheduleReader,
  SqliteReminderStateStore,
} from '../features/reminder';
import { PermissionOnboardingScreen } from '../features/reminder';
import { SqliteScheduleClientService } from '../features/schedule/application';
import type { ScheduleLocalRepository } from '../features/schedule/data';
import { RNAppStateProvider } from '../infrastructure/appState/RNAppStateProvider';
import type { ApiRequest } from '../infrastructure/network/client';
import type { AuthenticatedWebSocketClient } from '../infrastructure/websocket';
import { openTimeflowDatabase } from '../infrastructure/database';
import { ExpoLocationProvider } from '../infrastructure/location/ExpoLocationProvider';
import { HomeScreen } from '../screens/HomeScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { colors, spacing } from '../shared/ui/theme';
import { AppProviders } from './AppProviders';
import { createAppServices, type AppServices } from './composition/createAppServices';
import { createScheduleSnapshotPreparation } from './composition/createScheduleSnapshotPreparation';

export function AppRoot({ services: providedServices }: { services?: AppServices }) {
  const services = useMemo(() => providedServices ?? createAppServices(), [providedServices]);
  const controller = services.auth.controller;
  const handlePermissionsUpdated = useCallback(() => {
    void services.reminder.rebuild();
  }, [services]);
  return (
    <AppProviders
      authController={controller}
      invalidationCoordinator={services.auth.invalidationCoordinator}
      services={services}
    >
      <AuthRoute
        alertDialog={services.alertDialog}
        device={services.reminderPorts.device}
        onPermissionsUpdated={handlePermissionsUpdated}
        protectedClient={services.protectedClient}
        reminder={services.reminder}
        reminderState={services.reminderState}
        scheduleReader={services.schedules}
        webSocketClient={services.webSocketClient}
      />
    </AppProviders>
  );
}

function AuthRoute({
  alertDialog,
  device,
  onPermissionsUpdated,
  protectedClient,
  reminder,
  reminderState,
  scheduleReader,
  webSocketClient,
}: {
  readonly alertDialog: AlertDialogPort;
  readonly device: DeviceCapabilityPort;
  readonly onPermissionsUpdated: () => void;
  readonly protectedClient: ApiRequest;
  readonly reminder: ReminderApplicationPort;
  readonly reminderState: SqliteReminderStateStore;
  readonly scheduleReader: SqliteLocalScheduleReader;
  readonly webSocketClient: AuthenticatedWebSocketClient;
}) {
  const { retryInitialization, viewState } = useAuth();

  if (viewState.status === 'loading') {
    return (
      <View style={styles.authenticatedScreen}>
        <Text style={styles.title}>正在恢复登录状态</Text>
        {viewState.initializationError ? (
          <Text style={styles.account}>{viewState.initializationError}</Text>
        ) : null}
        {viewState.initializationError ? (
          <Text
            accessibilityRole="button"
            onPress={() => void retryInitialization()}
            style={styles.account}
          >
            重试
          </Text>
        ) : null}
      </View>
    );
  }

  if (viewState.status === 'unauthenticated') {
    return <LoginScreen />;
  }

  return (
    <AuthenticatedScheduleRoute
      accountId={viewState.accountId}
      alertDialog={alertDialog}
      device={device}
      key={viewState.accountId}
      onPermissionsUpdated={onPermissionsUpdated}
      protectedClient={protectedClient}
      reminder={reminder}
      reminderState={reminderState}
      scheduleReader={scheduleReader}
      username={viewState.username}
      webSocketClient={webSocketClient}
    />
  );
}

type ScheduleLoadState =
  | {
      readonly repository: ScheduleLocalRepository;
      readonly retryToken: number;
      readonly status: 'ready';
    }
  | {
      readonly retryToken: number;
      readonly status: 'error';
    };

function AuthenticatedScheduleRoute({
  accountId,
  alertDialog,
  device,
  onPermissionsUpdated,
  protectedClient,
  reminder,
  reminderState,
  scheduleReader,
  username,
  webSocketClient,
}: {
  readonly accountId: string;
  readonly alertDialog: AlertDialogPort;
  readonly device: DeviceCapabilityPort;
  readonly onPermissionsUpdated: () => void;
  readonly protectedClient: ApiRequest;
  readonly reminder: ReminderApplicationPort;
  readonly reminderState: SqliteReminderStateStore;
  readonly scheduleReader: SqliteLocalScheduleReader;
  readonly username: string;
  readonly webSocketClient: AuthenticatedWebSocketClient;
}) {
  const { signOut } = useAuth();
  const [loadState, setLoadState] = useState<ScheduleLoadState>();
  const [retryToken, setRetryToken] = useState(0);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [permissionGate, setPermissionGate] = useState<'checking' | 'gated' | 'clear'>('checking');
  const [highlightPermission, setHighlightPermission] = useState<DevicePermission | null>(null);

  // 只有通知是硬性门槛：没给就先留在权限页，其余权限允许先跳过，用到对应功能
  // 时再单独引导（见 useReminderPermissionNudge 和麦克风被拒的弹窗）。
  useEffect(() => {
    let active = true;
    void device.getStatus().then((status) => {
      if (active) setPermissionGate(status.permissions.notifications ? 'clear' : 'gated');
    });
    return () => {
      active = false;
    };
  }, [device]);

  const handleRequestPermission = useCallback((permission?: DevicePermission) => {
    setHighlightPermission(permission ?? null);
    setPermissionGate('gated');
  }, []);

  const handlePermissionsContinue = useCallback(() => {
    setPermissionGate('clear');
    setHighlightPermission(null);
  }, []);

  useEffect(() => {
    let active = true;
    const abortController = new AbortController();
    void (async () => {
      try {
        // 全应用共用的那一条连接，不在这里关闭：它同时被后台守护任务、围栏任务
        // 持有，切账号/点重试只是换一个 accountId 去查同一个库（每张表都带
        // account_id 过滤），连接本身不需要跟着重建。详见 sqlite.ts 里关于
        // 重复 open 会触发原生对象被提前释放的说明。
        const database = await openTimeflowDatabase();
        if (!active) return;
        const preparation = createScheduleSnapshotPreparation(database, protectedClient);
        await preparation.bootstrap.ensureLocalSnapshot(accountId, abortController.signal);
        if (active) {
          setLoadState({
            repository: preparation.repository,
            retryToken,
            status: 'ready',
          });
        }
      } catch {
        if (active) setLoadState({ retryToken, status: 'error' });
      }
    })();
    return () => {
      active = false;
      abortController.abort();
    };
  }, [accountId, protectedClient, retryToken]);

  const retryPreparation = useCallback(() => {
    setRetryToken((value) => value + 1);
  }, []);
  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  }, [isSigningOut, signOut]);
  const currentLoadState = loadState?.retryToken === retryToken ? loadState : undefined;

  const scheduleService = useMemo(
    () =>
      currentLoadState?.status === 'ready'
        ? new SqliteScheduleClientService(currentLoadState.repository)
        : undefined,
    [currentLoadState],
  );

  // The reminder runtime starts as soon as authentication succeeds, before SQLite may be ready.
  // Bind its stable adapters to the active account/repository, then refresh the running engine.
  useEffect(() => {
    if (currentLoadState?.status !== 'ready') {
      return;
    }
    reminderState.attach(currentLoadState.repository, accountId);
    scheduleReader.attach(currentLoadState.repository, accountId);
    void scheduleReader.refresh();
    return () => {
      scheduleReader.detach();
      reminderState.detach();
    };
  }, [accountId, currentLoadState, reminderState, scheduleReader]);

  // 语音这条连接复用应用唯一的 AuthenticatedWebSocketClient——握手、鉴权失效、
  // 断线通知都由它统一处理，这里不再单独持有 access_token/device_id/wsUrl。
  // 按住说话和免提通话共用同一批 capture/playback/location/appState 端口
  // （只有 transport 不同：各自绑定不同 voiceMode，连的还是同一条共享连接），
  // 两者不能同时抢麦克风，这个互斥在展示层（AssistantVoiceOverlay）按对方的
  // 状态置灰控件来保证，这里不做限制。
  const assistantDependencies = useMemo((): Omit<
    AssistantApplicationDependencies,
    'transport'
  > | null => {
    if (currentLoadState?.status !== 'ready') {
      return null;
    }
    return {
      appState: new RNAppStateProvider(),
      capture: new ExpoAudioCapture(),
      localScheduleWriter: new LocalScheduleWriter(currentLoadState.repository, scheduleReader),
      location: new ExpoLocationProvider(),
      playback: new ExpoAudioPlayback(),
    };
  }, [currentLoadState, scheduleReader]);

  const pushToTalkApplication = useMemo(() => {
    if (assistantDependencies === null) {
      return null;
    }
    return new AssistantConversationService(
      { accountId },
      { ...assistantDependencies, transport: new AuthenticatedVoiceTransport(webSocketClient) },
    );
  }, [assistantDependencies, accountId, webSocketClient]);

  const continuousApplication = useMemo(() => {
    if (assistantDependencies === null) {
      return null;
    }
    return new AssistantContinuousConversationService(
      { accountId },
      {
        ...assistantDependencies,
        transport: new AuthenticatedVoiceTransport(webSocketClient, 'continuous'),
      },
    );
  }, [assistantDependencies, accountId, webSocketClient]);

  // 换了新实例（重试数据库、账号变化）或这个路由整体卸载（比如登出）时，把旧
  // 实例上挂在共享连接上的监听器摘掉，不然会一直攒着。
  useEffect(() => {
    return () => {
      pushToTalkApplication?.dispose();
    };
  }, [pushToTalkApplication]);
  useEffect(() => {
    return () => {
      continuousApplication?.dispose();
    };
  }, [continuousApplication]);

  return (
    <View style={styles.authenticatedRoute}>
      {currentLoadState?.status === 'ready' &&
      scheduleService &&
      pushToTalkApplication &&
      continuousApplication ? (
        permissionGate === 'gated' ? (
          <PermissionOnboardingScreen
            device={device}
            highlightPermission={highlightPermission}
            onContinue={handlePermissionsContinue}
            onPermissionsUpdated={onPermissionsUpdated}
          />
        ) : permissionGate === 'checking' ? (
          <View style={styles.authenticatedScreen}>
            <Text style={styles.title}>正在检查权限</Text>
          </View>
        ) : (
          <HomeScreen
            accountId={accountId}
            alertDialog={alertDialog}
            continuousApplication={continuousApplication}
            isSigningOut={isSigningOut}
            onRequestPermission={handleRequestPermission}
            onSignOut={handleSignOut}
            pushToTalkApplication={pushToTalkApplication}
            reminder={reminder}
            scheduleService={scheduleService}
            timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
            username={username}
          />
        )
      ) : (
        <View style={styles.authenticatedScreen}>
          <Text style={styles.title}>
            {currentLoadState?.status === 'error' ? '日程同步失败' : '正在准备日程'}
          </Text>
          {currentLoadState?.status === 'error' ? (
            <Pressable accessibilityRole="button" onPress={retryPreparation} style={styles.retry}>
              <Text style={styles.retryText}>重试</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="退出登录"
            accessibilityRole="button"
            accessibilityState={{ disabled: isSigningOut }}
            disabled={isSigningOut}
            onPress={() => void handleSignOut()}
            style={styles.loadStateSignOut}
          >
            <Text style={styles.loadStateSignOutText}>
              {isSigningOut ? '正在退出…' : '退出登录'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  account: { color: colors.mutedText, fontSize: 16, marginTop: spacing.sm },
  authenticatedRoute: { backgroundColor: colors.background, flex: 1 },
  authenticatedScreen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  loadStateSignOut: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  loadStateSignOutText: { color: colors.mutedText, fontWeight: '600' },
  retry: {
    backgroundColor: colors.text,
    borderRadius: 8,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.onPrimary, fontWeight: '700' },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
});
