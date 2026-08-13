import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AuthController } from '../features/auth/application';
import { useAuth } from '../features/auth/presentation/AuthProvider';
import { SqliteScheduleClientService } from '../features/schedule/application';
import { ScheduleLocalRepository } from '../features/schedule/data';
import { ScheduleCalendarScreen } from '../features/schedule/presentation/ScheduleCalendarScreen';
import { openTimeflowDatabase } from '../infrastructure/database';
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
      <AuthRoute />
    </AppProviders>
  );
}

function AuthRoute() {
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
    />
  );
}

type ScheduleLoadState =
  | {
      readonly retryToken: number;
      readonly service: SqliteScheduleClientService;
      readonly status: 'ready';
    }
  | {
      readonly retryToken: number;
      readonly status: 'error';
    };

function AuthenticatedScheduleRoute({
  accountId,
  username,
}: {
  readonly accountId: string;
  readonly username: string;
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
            retryToken,
            service: new SqliteScheduleClientService(new ScheduleLocalRepository(database)),
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
        {currentLoadState?.status === 'ready' ? (
          <ScheduleCalendarScreen
            accountId={accountId}
            service={currentLoadState.service}
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
  authenticatedScreen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  authenticatedContent: { flex: 1 },
  authenticatedRoute: { backgroundColor: colors.background, flex: 1 },
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
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
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
});
