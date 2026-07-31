import { useEffect, useMemo } from 'react';

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
  /** Tests and native hosts may provide a concrete background-aware provider. */
  provider?: LocationProvider;
}) {
  const { client, connectionStatus, items, provider } = options;
  const reporter = useMemo(
    () => (client ? new LocationReporter(client, provider ?? createLocationProvider()) : null),
    [client, provider],
  );

  useEffect(() => {
    if (!reporter || connectionStatus !== 'ready') {
      reporter?.stop();
      return;
    }
    reporter.syncArmedSchedules(items);
    return () => reporter.stop();
  }, [connectionStatus, items, reporter]);
}
