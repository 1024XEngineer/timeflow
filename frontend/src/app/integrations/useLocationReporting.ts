import { useEffect, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { ConnectionStatus } from '@/contracts';
import type { Schedule } from '@/features/schedule';
import {
  createLocationProvider,
  LocationReporter,
  type LocationProvider,
  type LocationTransport,
} from '@/infrastructure/location/LocationReporter';

export type { LocationProvider } from '@/infrastructure/location/LocationReporter';

export function useLocationReporting(options: {
  client: LocationTransport | null;
  connectionStatus: ConnectionStatus;
  items: Schedule[];
  /** Tests and native hosts may provide a concrete foreground provider. */
  provider?: LocationProvider;
}) {
  const { client, connectionStatus, items, provider } = options;
  const reporter = useMemo(
    () => (client ? new LocationReporter(client, provider ?? createLocationProvider()) : null),
    [client, provider],
  );

  useEffect(() => {
    if (!reporter) return;

    const syncForState = (state: AppStateStatus) => {
      if (connectionStatus !== 'ready' || state !== 'active') {
        reporter.stop();
        return;
      }
      reporter.syncArmedSchedules(items);
    };

    syncForState(AppState.currentState);
    const subscription = AppState.addEventListener('change', syncForState);
    return () => {
      subscription.remove();
      reporter.stop();
    };
  }, [connectionStatus, items, reporter]);
}
