import { createContext, type PropsWithChildren, useContext, useMemo } from 'react';

import type { AppServices } from './createAppServices';

export type AppFeatureServices = Pick<
  AppServices,
  'protectedClient' | 'reminder' | 'scheduleView' | 'webSocketClient'
>;

const AppServicesContext = createContext<AppFeatureServices | undefined>(undefined);

/** 只向功能模块暴露认证后的业务依赖，不暴露认证控制器或原始会话。 */
export function AppServicesProvider({
  children,
  services,
}: PropsWithChildren<{ readonly services: AppServices }>) {
  const value = useMemo<AppFeatureServices>(
    () => ({
      protectedClient: services.protectedClient,
      reminder: services.reminder,
      scheduleView: services.scheduleView,
      webSocketClient: services.webSocketClient,
    }),
    [services],
  );

  return <AppServicesContext.Provider value={value}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppFeatureServices {
  const services = useContext(AppServicesContext);
  if (!services) {
    throw new Error('AppServicesProvider is required');
  }
  return services;
}
