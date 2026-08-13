import { type PropsWithChildren, useEffect } from 'react';

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
  return (
    <AuthProvider controller={authController} invalidationCoordinator={invalidationCoordinator}>
      <AppServicesProvider services={services}>
        <AuthenticatedRuntime
          alertDialog={services.alertDialog}
          device={services.reminderPorts.device}
          runtime={services.runtime}
        />
        {children}
      </AppServicesProvider>
    </AuthProvider>
  );
}

function AuthenticatedRuntime({
  alertDialog,
  device,
  runtime,
}: {
  readonly alertDialog: AppServices['alertDialog'];
  readonly device: AppServices['reminderPorts']['device'];
  readonly runtime: AppServices['runtime'];
}) {
  const { viewState } = useAuth();
  const authenticated = viewState.status === 'authenticated';
  useReminderPermissionsOnLaunch(authenticated ? device : null, authenticated ? alertDialog : null);

  useEffect(() => {
    if (viewState.status !== 'authenticated') {
      return;
    }

    void runtime.start();
    return () => {
      void runtime.stop();
    };
  }, [runtime, viewState.status]);

  return null;
}
