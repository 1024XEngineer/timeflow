import { useEffect, useMemo, type PropsWithChildren } from 'react';

import { createAppServices } from './composition/createAppServices';
import { useReminderPermissionsOnLaunch } from '../features/reminder';

/** 组合应用级提供器，并启动提醒运行时。 */
export function AppProviders({ children }: PropsWithChildren) {
  const services = useMemo(() => createAppServices(), []);
  useReminderPermissionsOnLaunch(services.reminderPorts.device);

  useEffect(() => {
    void services.runtime.start();
    return () => {
      void services.runtime.stop();
    };
  }, [services]);

  return children;
}
