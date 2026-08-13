import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AssistantContinuousConversationService } from '../features/assistant/application/AssistantContinuousConversationService';
import { AssistantConversationService } from '../features/assistant/application/AssistantConversationService';
import type { AssistantApplicationDependencies } from '../features/assistant/application/interfaces/AssistantApplicationPort';
import { ExpoAudioCapture } from '../features/assistant/data/audio/ExpoAudioCapture';
import { ExpoAudioPlayback } from '../features/assistant/data/audio/ExpoAudioPlayback';
import { AuthenticatedVoiceTransport } from '../features/assistant/data/websocket/AuthenticatedVoiceTransport';
import { LocalScheduleWriter } from '../features/assistant/data/local/LocalScheduleWriter';
import type { AuthController } from '../features/auth/application';
import { useAuth } from '../features/auth/presentation/AuthProvider';
import { SqliteScheduleClientService } from '../features/schedule/application';
import { ScheduleLocalRepository } from '../features/schedule/data';
import { RNAppStateProvider } from '../infrastructure/appState/RNAppStateProvider';
import type { AuthenticatedWebSocketClient } from '../infrastructure/websocket';
import { openTimeflowDatabase } from '../infrastructure/database';
import { ExpoLocationProvider } from '../infrastructure/location/ExpoLocationProvider';
import { HomeScreen } from '../screens/HomeScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { colors, spacing } from '../shared/ui/theme';
import { AppProviders } from './AppProviders';
import { createAppServices, type AppServices } from './composition/createAppServices';

export function AppRoot({
  authController,
  services: providedServices,
}: {
  authController?: AuthController;
  services?: AppServices;
}) {
  const services = useMemo(() => providedServices ?? createAppServices(), [providedServices]);
  const controller = authController ?? services.auth.controller;
  return (
    <AppProviders
      authController={controller}
      invalidationCoordinator={authController ? undefined : services.auth.invalidationCoordinator}
      services={services}
    >
      <AuthRoute webSocketClient={services.webSocketClient} />
    </AppProviders>
  );
}

function AuthRoute({
  webSocketClient,
}: {
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
      key={viewState.accountId}
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
  username,
  webSocketClient,
}: {
  readonly accountId: string;
  readonly username: string;
  readonly webSocketClient: AuthenticatedWebSocketClient;
}) {
  const { signOut } = useAuth();
  const [loadState, setLoadState] = useState<ScheduleLoadState>();
  const [retryToken, setRetryToken] = useState(0);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    openTimeflowDatabase()
      .then((database) => {
        if (active) {
          setLoadState({
            repository: new ScheduleLocalRepository(database),
            retryToken,
            status: 'ready',
          });
        }
      })
      .catch(() => {
        if (active) setLoadState({ retryToken, status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [retryToken]);

  const retryDatabase = useCallback(() => {
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
      localScheduleWriter: new LocalScheduleWriter(currentLoadState.repository),
      location: new ExpoLocationProvider(),
      playback: new ExpoAudioPlayback(),
    };
  }, [currentLoadState]);

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
      <View style={styles.accountBar}>
        <Text numberOfLines={1} style={styles.accountIdentity}>
          账号：{username}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: isSigningOut }}
          disabled={isSigningOut}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [
            styles.signOutButton,
            pressed && !isSigningOut && styles.signOutButtonPressed,
          ]}
        >
          <Text style={styles.signOutText}>{isSigningOut ? '正在退出…' : '退出登录'}</Text>
        </Pressable>
      </View>
      <View style={styles.authenticatedContent}>
        {currentLoadState?.status === 'ready' &&
        scheduleService &&
        pushToTalkApplication &&
        continuousApplication ? (
          <HomeScreen
            accountId={accountId}
            continuousApplication={continuousApplication}
            pushToTalkApplication={pushToTalkApplication}
            scheduleService={scheduleService}
            timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
        ) : (
          <View style={styles.authenticatedScreen}>
            <Text style={styles.title}>
              {currentLoadState?.status === 'error' ? '本地日程存储初始化失败' : '正在准备日程'}
            </Text>
            {currentLoadState?.status === 'error' ? (
              <Pressable accessibilityRole="button" onPress={retryDatabase} style={styles.retry}>
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  account: { color: colors.mutedText, fontSize: 16, marginTop: spacing.sm },
  accountBar: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  accountIdentity: { color: colors.mutedText, flex: 1, fontSize: 14 },
  authenticatedContent: { flex: 1 },
  authenticatedRoute: { backgroundColor: colors.background, flex: 1 },
  authenticatedScreen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  retry: {
    backgroundColor: colors.text,
    borderRadius: 8,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.onPrimary, fontWeight: '700' },
  signOutButton: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  signOutButtonPressed: { opacity: 0.7 },
  signOutText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
});
