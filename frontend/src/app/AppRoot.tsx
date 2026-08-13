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

  return <AuthenticatedScheduleRoute accountId={viewState.accountId} key={viewState.accountId} />;
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

function AuthenticatedScheduleRoute({ accountId }: { readonly accountId: string }) {
  const [loadState, setLoadState] = useState<ScheduleLoadState>();
  const [retryToken, setRetryToken] = useState(0);

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
  const currentLoadState = loadState?.retryToken === retryToken ? loadState : undefined;

  return currentLoadState?.status === 'ready' ? (
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
      <Text style={styles.account}>账号：{accountId}</Text>
      {currentLoadState?.status === 'error' ? (
        <Pressable accessibilityRole="button" onPress={retryDatabase} style={styles.retry}>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      ) : null}
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
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  retry: {
    backgroundColor: colors.text,
    borderRadius: 8,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.onPrimary, fontWeight: '700' },
});
