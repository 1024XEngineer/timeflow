import type {
  LocationMonitorEvent,
  LocationMonitorPort,
  LocationRebuildTarget,
  LocationWatchHandle,
  LocationWatchRequest,
} from '../../features/reminder/application/interfaces';
import type { LocationSample } from '../../features/reminder/domain';

import type { LocationProvider } from './LocationProvider';

const MOCK_SAMPLE: LocationSample = {
  latitude: 31.2304,
  longitude: 121.4737,
  accuracy_meters: 12,
  observed_at: '2026-08-07T01:00:00.000Z',
};

/** 固定定位能力适配器，不访问平台定位接口。 */
export class MockLocationMonitor implements LocationMonitorPort, LocationProvider {
  async watch(
    request: LocationWatchRequest,
    _listener: (event: LocationMonitorEvent) => void,
  ): Promise<LocationWatchHandle> {
    return {
      listener_id: `mock-location-listener-${request.schedule_id}`,
      schedule_id: request.schedule_id,
    };
  }

  async unwatch(_listenerId: string): Promise<void> {
    return Promise.resolve();
  }

  async rebuild(
    targets: readonly LocationRebuildTarget[],
    _listener: (event: LocationMonitorEvent) => void,
  ): Promise<readonly LocationWatchHandle[]> {
    return targets.map((target) => ({
      listener_id: `mock-location-listener-${target.schedule_id}`,
      schedule_id: target.schedule_id,
    }));
  }

  async getLastSample(): Promise<LocationSample | null> {
    return { ...MOCK_SAMPLE };
  }

  async getCurrentSample(): Promise<LocationSample | null> {
    return { ...MOCK_SAMPLE };
  }
}

export { MOCK_SAMPLE as MOCK_LOCATION_SAMPLE };
