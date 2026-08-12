import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { accessAuth } from '../api/auth';
import type { AuthAccessResponse } from '../contracts/auth';
import { LoginScreen } from '../screens/LoginScreen';
import { colors, spacing } from '../shared/ui/theme';
import { AppProviders } from './AppProviders';

export function AppRoot() {
  const [session, setSession] = useState<AuthAccessResponse>();

  return (
    <AppProviders>
      {session ? (
        <View style={styles.authenticatedScreen}>
          <Text style={styles.title}>登录成功</Text>
          <Text style={styles.account}>账号：{session.account_id}</Text>
        </View>
      ) : (
        <LoginScreen authAccess={accessAuth} onAuthenticated={setSession} />
      )}
    </AppProviders>
  );
}

const styles = StyleSheet.create({
  account: {
    color: colors.mutedText,
    fontSize: 16,
    marginTop: spacing.sm,
  },
  authenticatedScreen: {
    alignItems: 'center',
    backgroundColor: colors.background,
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
});
