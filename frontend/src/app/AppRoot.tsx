import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AuthController } from '../features/auth/application';
import { useAuth } from '../features/auth/presentation/AuthProvider';
import type { AuthenticatedWebSocketClient } from '../infrastructure/websocket';
import { LoginScreen } from '../screens/LoginScreen';
import { colors, spacing } from '../shared/ui/theme';
import { AppProviders } from './AppProviders';
import { AuthenticatedLiveScheduleRoute } from './AuthenticatedLiveScheduleRoute';
import { AuthenticatedMockScheduleRoute } from './AuthenticatedMockScheduleRoute';
import { createAppServices, type AppServices } from './composition/createAppServices';
import { isMockMode } from './previewMode';

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

  if (isMockMode()) {
    return (
      <AuthenticatedMockScheduleRoute
        accountId={viewState.accountId}
        key={viewState.accountId}
        username={viewState.username}
      />
    );
  }

  return (
    <AuthenticatedLiveScheduleRoute
      accountId={viewState.accountId}
      key={viewState.accountId}
      username={viewState.username}
      webSocketClient={webSocketClient}
    />
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
});
