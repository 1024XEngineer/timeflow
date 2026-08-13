import { type PropsWithChildren, useEffect } from 'react';
import { AppState } from 'react-native';

import type { AuthController, AuthInvalidationCoordinator } from '../features/auth/application';
import { AuthProvider, useAuth } from '../features/auth/presentation/AuthProvider';
import { useReminderPermissionsOnLaunch } from '../features/reminder';
import { AppServicesProvider } from './composition/AppServicesProvider';
import type { AppServices } from './composition/createAppServices';

/** 组合认证边界、业务依赖注入和认证后模块生命周期。 */
export function AppProviders({
  authController,
  children,
  invalidationCoordinator,
  services,
}: PropsWithChildren<{
  authController: AuthController;
  invalidationCoordinator?: AuthInvalidationCoordinator;
  services: AppServices;
}>) {
  useReminderPermissionsOnLaunch(services.reminderPorts.device);
  return (
    <AuthProvider controller={authController} invalidationCoordinator={invalidationCoordinator}>
      <AppServicesProvider services={services}>
        <AuthenticatedRuntime reminder={services.reminder} runtime={services.runtime} />
        {children}
      </AppServicesProvider>
    </AuthProvider>
  );
}

function AuthenticatedRuntime({
  reminder,
  runtime,
}: {
  readonly reminder: AppServices['reminder'];
  readonly runtime: AppServices['runtime'];
}) {
  const { viewState } = useAuth();

  useEffect(() => {
    if (viewState.status !== 'authenticated') {
      return;
    }

    void runtime.start();
    return () => {
      void runtime.stop();
    };
  }, [runtime, viewState.status]);

  useEffect(() => {
    if (viewState.status !== 'authenticated') {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void reminder.rebuild();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [reminder, viewState.status]);

  return null;
}
