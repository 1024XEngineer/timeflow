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

    // 不 catch 的话，runtime.start() 里任何一个模块启动失败（哪怕只是某次原生
    // 调用偶发抛错）都会变成静默的 unhandled rejection——用户看到的就是"提醒/
    // 守护线程这次没起来"，没有任何日志能定位到具体是哪次启动失败的。
    services.runtime.start().catch((error) => {
      console.error('[app] runtime.start() failed', error);
    });
    return () => {
      services.runtime.stop().catch((error) => {
        console.error('[app] runtime.stop() failed', error);
      });
    };
  }, [isAuthenticated, services]);

  return null;
}
