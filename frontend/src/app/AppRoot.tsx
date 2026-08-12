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
import { createAuthRuntime } from './authRuntime';

export function AppRoot({ authController }: { authController?: AuthController }) {
  const runtime = useMemo(() => (authController ? undefined : createAuthRuntime()), [authController]);
  const controller = authController ?? runtime!.controller;
  return (
    <AppProviders authController={controller} invalidationCoordinator={runtime?.invalidationCoordinator}>
      <AuthRoute />
    </AppProviders>
  );
}

function AuthRoute() {
  const { retryInitialization, viewState } = useAuth();
  const accountId = viewState.status === 'authenticated' ? viewState.accountId : undefined;
  const [scheduleService, setScheduleService] = useState<SqliteScheduleClientService>();
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [databaseRetryToken, setDatabaseRetryToken] = useState(0);

  useEffect(() => {
    setScheduleService(undefined);
    setDatabaseError(null);
    if (!accountId) return;

    let active = true;
    openTimeflowDatabase()
      .then((database) => {
        if (active) {
          setScheduleService(
            new SqliteScheduleClientService(new ScheduleLocalRepository(database)),
          );
        }
      })
      .catch(() => {
        if (active) setDatabaseError('本地日程存储初始化失败');
      });
    return () => {
      active = false;
    };
  }, [accountId, databaseRetryToken]);

  const retryDatabase = useCallback(() => {
    setDatabaseRetryToken((value) => value + 1);
  }, []);

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

  return scheduleService ? (
    <ScheduleCalendarScreen
      accountId={viewState.accountId}
      service={scheduleService}
      timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    />
  ) : (
    <View style={styles.authenticatedScreen}>
      <Text style={styles.title}>{databaseError ?? '正在准备日程'}</Text>
      <Text style={styles.account}>账号：{viewState.accountId}</Text>
      {databaseError ? (
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
