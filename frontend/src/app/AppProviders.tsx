import { type PropsWithChildren, useEffect } from 'react';

import type { AuthController, AuthInvalidationCoordinator } from '../features/auth/application';
import { AuthProvider, useAuth } from '../features/auth/presentation/AuthProvider';
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
        <AuthenticatedRuntime services={services} />
        {children}
      </AppServicesProvider>
    </AuthProvider>
  );
}

function AuthenticatedRuntime({ services }: { readonly services: AppServices }) {
  const { viewState } = useAuth();
  const isAuthenticated = viewState.status === 'authenticated';

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    void services.runtime.start();
    return () => {
      void services.runtime.stop();
    };
  }, [isAuthenticated, services]);

  return null;
}
