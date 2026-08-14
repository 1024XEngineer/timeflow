import { type PropsWithChildren, useEffect } from 'react';
import { AppState } from 'react-native';

import type { AuthController, AuthInvalidationCoordinator } from '../features/auth/application';
import { AuthProvider, useAuth } from '../features/auth/presentation/AuthProvider';
import {
  hydrateInMemorySchedulesFromLocalDb,
  isHydratableScheduleReader,
  useReminderPermissionsOnLaunch,
} from '../features/reminder';
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
        <AuthenticatedRuntime services={services} />
        {children}
      </AppServicesProvider>
    </AuthProvider>
  );
}

function AuthenticatedRuntime({ services }: { readonly services: AppServices }) {
  const { viewState } = useAuth();
  const { reminder, reminderPorts, runtime } = services;
  const accountId = viewState.status === 'authenticated' ? viewState.accountId : null;

  useEffect(() => {
    if (accountId == null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      if (isHydratableScheduleReader(reminderPorts.schedules)) {
        await hydrateInMemorySchedulesFromLocalDb(reminderPorts.schedules, accountId);
      }
      if (!cancelled) {
        await runtime.start();
      }
    })();
    return () => {
      cancelled = true;
      void runtime.stop();
    };
  }, [accountId, reminderPorts.schedules, runtime]);

  useEffect(() => {
    if (accountId == null) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void (async () => {
        if (isHydratableScheduleReader(reminderPorts.schedules)) {
          await hydrateInMemorySchedulesFromLocalDb(reminderPorts.schedules, accountId);
        }
        await reminder.rebuild();
      })();
    });
    return () => {
      subscription.remove();
    };
  }, [accountId, reminder, reminderPorts.schedules]);

  return null;
}
