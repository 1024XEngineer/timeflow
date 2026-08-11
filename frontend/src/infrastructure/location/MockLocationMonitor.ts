import type {
  LocationMonitorEvent,
  LocationMonitorPort,
  LocationWatchHandle,
  LocationWatchRequest,
} from '../../features/reminder/application/interfaces';
import type { LocalReminderSchedule, LocationSample } from '../../features/reminder/domain';

import type { LocationProvider } from './LocationProvider';

const MOCK_SAMPLE: LocationSample = {
  latitude: 31.2304,
  longitude: 121.4737,
  accuracy_meters: 12,
  observed_at: '2026-08-07T01:00:00.000Z',
};

function isLocationSchedule(schedule: LocalReminderSchedule): boolean {
  return schedule.schedule_type === 'location' && schedule.status === 'active';
}

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
    schedules: readonly LocalReminderSchedule[],
    _listener: (event: LocationMonitorEvent) => void,
  ): Promise<readonly LocationWatchHandle[]> {
    return schedules.filter(isLocationSchedule).map((schedule) => ({
      listener_id: `mock-location-listener-${schedule.id}`,
      schedule_id: schedule.id,
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
