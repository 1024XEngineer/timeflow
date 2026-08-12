import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { accessAuth } from '../api/auth';
import type { AuthAccessResponse } from '../contracts/auth';
import { SqliteScheduleClientService } from '../features/schedule/application';
import { ScheduleLocalRepository } from '../features/schedule/data';
import { ScheduleCalendarScreen } from '../features/schedule/presentation/ScheduleCalendarScreen';
import { openTimeflowDatabase } from '../infrastructure/database';
import { LoginScreen } from '../screens/LoginScreen';
import { colors, spacing } from '../shared/ui/theme';
import { AppProviders } from './AppProviders';

export function AppRoot() {
  const [session, setSession] = useState<AuthAccessResponse>();
  const [scheduleService, setScheduleService] = useState<SqliteScheduleClientService>();
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [databaseRetryToken, setDatabaseRetryToken] = useState(0);

  useEffect(() => {
    if (!session) return;
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
  }, [databaseRetryToken, session]);

  const retryDatabase = useCallback(() => {
    setScheduleService(undefined);
    setDatabaseError(null);
    setDatabaseRetryToken((value) => value + 1);
  }, []);

  return (
    <AppProviders>
      {session ? (
        scheduleService ? (
          <ScheduleCalendarScreen
            accountId={session.account_id}
            service={scheduleService}
            timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
        ) : (
          <View style={styles.authenticatedScreen}>
            <Text style={styles.title}>{databaseError ?? '正在准备日程'}</Text>
            <Text style={styles.account}>账号：{session.account_id}</Text>
            {databaseError ? (
              <Pressable accessibilityRole="button" onPress={retryDatabase} style={styles.retry}>
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            ) : null}
          </View>
        )
      ) : (
        <LoginScreen authAccess={accessAuth} onAuthenticated={setSession} />
      )}
    </AppProviders>
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
