import { type PropsWithChildren, useEffect } from 'react';

import type { AuthController, AuthInvalidationCoordinator } from '../features/auth/application';
import { AuthProvider, useAuth } from '../features/auth/presentation/AuthProvider';
import { useLocationPermissionsOnLaunch } from '../features/reminder';
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
  useLocationPermissionsOnLaunch();
  return (
    <AuthProvider controller={authController} invalidationCoordinator={invalidationCoordinator}>
      <AppServicesProvider services={services}>
        <AuthenticatedRuntime runtime={services.runtime} />
        {children}
      </AppServicesProvider>
    </AuthProvider>
  );
}

function AuthenticatedRuntime({ runtime }: { readonly runtime: AppServices['runtime'] }) {
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

  return null;
}
