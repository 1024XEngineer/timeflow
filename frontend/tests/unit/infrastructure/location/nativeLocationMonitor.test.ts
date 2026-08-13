import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';

import { NativeLocationMonitor } from '../../../../src/infrastructure/location/NativeLocationMonitor';
import type { GeofenceTaskPayload } from '../../../../src/infrastructure/location/geofenceTask';
import type { LocationMonitorEvent } from '../../../../src/features/reminder/application/interfaces';

const mockUnsubscribeTask = jest.fn();
let taskListener: ((payload: GeofenceTaskPayload) => void) | null = null;

jest.mock('../../../../src/infrastructure/location/geofenceTask', () => ({
  GEOFENCE_TASK_NAME: 'timeflow-geofence',
  subscribeGeofenceTaskEvents: (listener: (payload: GeofenceTaskPayload) => void) => {
    taskListener = listener;
    return mockUnsubscribeTask;
  },
}));

const CENTER = { latitude: 31.2304, longitude: 121.4737 };

describe('NativeLocationMonitor', () => {
  beforeEach(() => {
    taskListener = null;
    mockUnsubscribeTask.mockReset();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({
      remove: jest.fn(),
    } as ReturnType<typeof AppState.addEventListener>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers a watch and forwards geofence task enter/exit events', async () => {
    const monitor = new NativeLocationMonitor();
    const events: LocationMonitorEvent[] = [];
    const handle = await monitor.watch(
      {
        schedule_id: 'schedule-loc',
        center: CENTER,
        radius_meters: 120,
        mode: 'arrive',
        background: true,
      },
      (event) => {
        events.push(event);
      },
    );

    expect(handle).toEqual({ listener_id: 'location-schedule-loc', schedule_id: 'schedule-loc' });
    await expect(monitor.getLastSample()).resolves.toBeNull();

    taskListener?.({
      schedule_id: 'schedule-loc',
      event: 'enter',
      latitude: 31.2304,
      longitude: 121.4737,
      radius: 120,
      observed_at: '2026-08-13T08:00:00.000Z',
    });
    taskListener?.({
      schedule_id: 'other',
      event: 'exit',
      latitude: 31.23,
      longitude: 121.47,
      radius: 120,
      observed_at: '2026-08-13T08:01:00.000Z',
    });
    taskListener?.({
      schedule_id: 'schedule-loc',
      event: 'exit',
      latitude: 31.24,
      longitude: 121.48,
      radius: 120,
      observed_at: '2026-08-13T08:02:00.000Z',
    });

    expect(events.map((event) => event.phase)).toEqual(['entered', 'left']);
    expect(events[0]?.schedule_id).toBe('schedule-loc');
    await expect(monitor.getLastSample()).resolves.toMatchObject({
      latitude: 31.24,
      longitude: 121.48,
    });

    await monitor.unwatch(handle.listener_id);
    monitor.dispose();
    expect(mockUnsubscribeTask).toHaveBeenCalledTimes(1);
  });

  it('rebuilds by replacing previous watches', async () => {
    const monitor = new NativeLocationMonitor();
    const events: string[] = [];
    await monitor.watch(
      {
        schedule_id: 'old',
        center: CENTER,
        radius_meters: 80,
        mode: 'arrive',
        background: false,
      },
      () => undefined,
    );
    const handles = await monitor.rebuild(
      [
        {
          schedule_id: 'new',
          center: CENTER,
          radius_meters: 90,
          mode: 'return',
          background: true,
        },
      ],
      (event) => {
        events.push(event.schedule_id);
      },
    );
    expect(handles).toEqual([{ listener_id: 'location-new', schedule_id: 'new' }]);
    taskListener?.({
      schedule_id: 'old',
      event: 'enter',
      latitude: CENTER.latitude,
      longitude: CENTER.longitude,
      radius: 80,
      observed_at: '2026-08-13T08:00:00.000Z',
    });
    taskListener?.({
      schedule_id: 'new',
      event: 'enter',
      latitude: CENTER.latitude,
      longitude: CENTER.longitude,
      radius: 90,
      observed_at: '2026-08-13T08:00:00.000Z',
    });
    expect(events).toEqual(['new']);
    monitor.dispose();
  });
});
