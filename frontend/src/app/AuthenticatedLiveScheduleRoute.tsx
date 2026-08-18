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
import { SqliteScheduleClientService } from '../features/schedule/application';
import { ScheduleLocalRepository } from '../features/schedule/data';
import { RNAppStateProvider } from '../infrastructure/appState/RNAppStateProvider';
import type { AuthenticatedWebSocketClient } from '../infrastructure/websocket';
import { openTimeflowDatabase } from '../infrastructure/database';
import { ExpoLocationProvider } from '../infrastructure/location/ExpoLocationProvider';
import { HomeScreen } from '../screens/HomeScreen';
import { colors, spacing } from '../shared/ui/theme';

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

export function AuthenticatedLiveScheduleRoute({
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
        <HomeScreen
          accountId={accountId}
          continuousApplication={continuousApplication}
          isSigningOut={isSigningOut}
          onSignOut={handleSignOut}
          pushToTalkApplication={pushToTalkApplication}
          scheduleService={scheduleService}
          timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          username={username}
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
