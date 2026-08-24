import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';
import { AppState } from 'react-native';

import type {
  LocationMonitorEvent,
  LocationWatchRequest,
} from '../../../../src/features/reminder/application/interfaces';
import { ExpoLocationMonitor } from '../../../../src/infrastructure/location/ExpoLocationMonitor';
import {
  drainPendingGeofenceEvents,
  subscribeGeofenceTaskEvents,
} from '../../../../src/infrastructure/location/geofenceTask';

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  hasStartedGeofencingAsync: jest.fn(),
  stopGeofencingAsync: jest.fn(),
  startGeofencingAsync: jest.fn(),
}));

jest.mock('../../../../src/infrastructure/location/geofenceTask', () => ({
  GEOFENCE_TASK_NAME: 'timeflow-geofence',
  subscribeGeofenceTaskEvents: jest.fn(),
  drainPendingGeofenceEvents: jest.fn(),
}));

const getForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
>;
const requestForeground = Location.requestForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.requestForegroundPermissionsAsync
>;
const getBackground = Location.getBackgroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getBackgroundPermissionsAsync
>;
const requestBackground = Location.requestBackgroundPermissionsAsync as jest.MockedFunction<
  typeof Location.requestBackgroundPermissionsAsync
>;
const getCurrentPosition = Location.getCurrentPositionAsync as jest.MockedFunction<
  typeof Location.getCurrentPositionAsync
>;
const hasStartedGeofencing = Location.hasStartedGeofencingAsync as jest.MockedFunction<
  typeof Location.hasStartedGeofencingAsync
>;
const stopGeofencing = Location.stopGeofencingAsync as jest.MockedFunction<
  typeof Location.stopGeofencingAsync
>;
const startGeofencing = Location.startGeofencingAsync as jest.MockedFunction<
  typeof Location.startGeofencingAsync
>;
const subscribeTaskEvents = subscribeGeofenceTaskEvents as jest.MockedFunction<
  typeof subscribeGeofenceTaskEvents
>;
const drainPending = drainPendingGeofenceEvents as jest.MockedFunction<
  typeof drainPendingGeofenceEvents
>;

function granted(): Location.LocationPermissionResponse {
  return {
    status: 'granted' as Location.PermissionStatus,
    canAskAgain: true,
    granted: true,
    expires: 'never',
  };
}

function denied(canAskAgain = true): Location.LocationPermissionResponse {
  return {
    status: 'denied' as Location.PermissionStatus,
    canAskAgain,
    granted: false,
    expires: 'never',
  };
}

function request(overrides: Partial<LocationWatchRequest> = {}): LocationWatchRequest {
  return {
    schedule_id: 'schedule-1',
    center: { latitude: 31.2, longitude: 121.5 },
    radius_meters: 200,
    mode: 'arrive',
    background: true,
    ...overrides,
  };
}

function position(overrides: Partial<Location.LocationObjectCoords> = {}) {
  return {
    coords: {
      latitude: 31.2,
      longitude: 121.5,
      accuracy: 12,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...overrides,
    },
    timestamp: Date.parse('2026-08-19T08:00:00.000Z'),
  };
}

describe('ExpoLocationMonitor', () => {
  let taskListener: ((payload: unknown) => void) | undefined;
  let appStateHandler: ((state: string) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    taskListener = undefined;
    appStateHandler = undefined;

    subscribeTaskEvents.mockImplementation((listener) => {
      taskListener = listener as (payload: unknown) => void;
      return jest.fn();
    });
    drainPending.mockResolvedValue([]);

    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });

    getForeground.mockResolvedValue(granted());
    getBackground.mockResolvedValue(granted());
    requestForeground.mockResolvedValue(granted());
    requestBackground.mockResolvedValue(granted());
    getCurrentPosition.mockResolvedValue(position());
    hasStartedGeofencing.mockResolvedValue(false);
    stopGeofencing.mockResolvedValue(undefined);
    startGeofencing.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('subscribes to geofence task events and app-state changes on construction', () => {
    new ExpoLocationMonitor();
    expect(subscribeTaskEvents).toHaveBeenCalledTimes(1);
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  describe('watch()', () => {
    it('registers a watch, syncs regions, and delivers an initial inside sample', async () => {
      const monitor = new ExpoLocationMonitor();
      const events: LocationMonitorEvent[] = [];
      const handle = await monitor.watch(request(), (event) => events.push(event));

      expect(handle).toEqual({ listener_id: 'location-schedule-1', schedule_id: 'schedule-1' });
      expect(startGeofencing).toHaveBeenCalledWith(
        'timeflow-geofence',
        expect.arrayContaining([expect.objectContaining({ identifier: 'schedule-1' })]),
      );
      expect(events).toEqual([
        {
          schedule_id: 'schedule-1',
          sample: {
            latitude: 31.2,
            longitude: 121.5,
            accuracy_meters: 12,
            observed_at: '2026-08-19T08:00:00.000Z',
          },
          phase: 'inside',
        },
      ]);
    });

    it('does not deliver an initial sample when the current position is unavailable', async () => {
      getForeground.mockResolvedValue(denied(false));
      requestForeground.mockResolvedValue(denied(false));
      const monitor = new ExpoLocationMonitor();
      const listener = jest.fn();
      await monitor.watch(request(), listener);
      expect(listener).not.toHaveBeenCalled();
    });

    it('replaces an existing watch for the same schedule_id instead of stacking two', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      await monitor.watch(request({ radius_meters: 500 }), jest.fn());

      const lastCall = startGeofencing.mock.calls.at(-1);
      const regions = lastCall?.[1] as { identifier: string; radius: number }[];
      expect(regions).toHaveLength(1);
      expect(regions[0]).toMatchObject({ identifier: 'schedule-1', radius: 500 });
    });

    it('replays events queued while the app process was headless', async () => {
      drainPending.mockResolvedValue([
        {
          schedule_id: 'schedule-1',
          event: 'enter',
          latitude: 31.21,
          longitude: 121.51,
          radius: 200,
          observed_at: '2026-08-19T09:00:00.000Z',
        },
      ]);
      const monitor = new ExpoLocationMonitor();
      const events: LocationMonitorEvent[] = [];
      await monitor.watch(request(), (event) => events.push(event));

      expect(events.at(-1)).toEqual({
        schedule_id: 'schedule-1',
        sample: {
          latitude: 31.21,
          longitude: 121.51,
          accuracy_meters: 200,
          observed_at: '2026-08-19T09:00:00.000Z',
        },
        phase: 'entered',
      });
    });
  });

  describe('unwatch()', () => {
    it('stops the system geofence once the last watch is removed', async () => {
      hasStartedGeofencing.mockResolvedValue(true);
      const monitor = new ExpoLocationMonitor();
      const handle = await monitor.watch(request(), jest.fn());
      await monitor.unwatch(handle.listener_id);

      expect(stopGeofencing).toHaveBeenCalledWith('timeflow-geofence');
    });

    it('does nothing for an unknown listener id', async () => {
      const monitor = new ExpoLocationMonitor();
      await expect(monitor.unwatch('does-not-exist')).resolves.toBeUndefined();
      expect(startGeofencing).not.toHaveBeenCalled();
    });
  });

  describe('rebuild()', () => {
    it('replaces every watch with one sync and fans the sample out to all handles', async () => {
      const monitor = new ExpoLocationMonitor();
      const events: LocationMonitorEvent[] = [];
      const handles = await monitor.rebuild(
        [
          {
            schedule_id: 'a',
            center: { latitude: 1, longitude: 2 },
            radius_meters: 100,
            mode: 'arrive',
            background: true,
          },
          {
            schedule_id: 'b',
            center: { latitude: 3, longitude: 4 },
            radius_meters: 150,
            mode: 'return',
            background: false,
          },
        ],
        (event) => events.push(event),
      );

      expect(handles).toEqual([
        { listener_id: 'location-a', schedule_id: 'a' },
        { listener_id: 'location-b', schedule_id: 'b' },
      ]);
      expect(startGeofencing).toHaveBeenCalledTimes(1);
      expect(events.map((e) => e.schedule_id)).toEqual(['a', 'b']);
    });

    it('stops geofencing when rebuilt with no targets', async () => {
      hasStartedGeofencing.mockResolvedValue(true);
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      stopGeofencing.mockClear();

      await monitor.rebuild([], jest.fn());
      expect(stopGeofencing).toHaveBeenCalledWith('timeflow-geofence');
    });
  });

  describe('getCurrentSample() / getLastSample()', () => {
    it('returns null before any sample has ever been taken', async () => {
      const monitor = new ExpoLocationMonitor();
      await expect(monitor.getLastSample()).resolves.toBeNull();
    });

    it('falls back to the last known sample when foreground permission is missing', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      const cached = await monitor.getLastSample();

      getForeground.mockResolvedValue(denied(false));
      requestForeground.mockResolvedValue(denied(false));
      await expect(monitor.getCurrentSample()).resolves.toEqual(cached);
      expect(getCurrentPosition).toHaveBeenCalledTimes(1); // only from the watch() call above
    });

    it('falls back to the last known sample when the position read throws', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      const cached = await monitor.getLastSample();

      getCurrentPosition.mockRejectedValue(new Error('gps unavailable'));
      await expect(monitor.getCurrentSample()).resolves.toEqual(cached);
    });

    it('defaults accuracy to 0 when the platform does not report it', async () => {
      getCurrentPosition.mockResolvedValue(position({ accuracy: null }));
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      await expect(monitor.getLastSample()).resolves.toMatchObject({ accuracy_meters: 0 });
    });
  });

  describe('dispose()', () => {
    it('unsubscribes from task events, removes the app-state listener, and stops an active geofence', async () => {
      const removeAppState = jest.fn();
      jest.spyOn(AppState, 'addEventListener').mockReturnValue({
        remove: removeAppState,
      } as unknown as ReturnType<typeof AppState.addEventListener>);
      const unsubscribeTask = jest.fn();
      subscribeTaskEvents.mockReturnValue(unsubscribeTask);
      hasStartedGeofencing.mockResolvedValue(true);

      const monitor = new ExpoLocationMonitor();
      monitor.dispose();
      await Promise.resolve();
      await Promise.resolve();

      expect(unsubscribeTask).toHaveBeenCalledTimes(1);
      expect(removeAppState).toHaveBeenCalledTimes(1);
      expect(stopGeofencing).toHaveBeenCalledWith('timeflow-geofence');
    });

    it('does not stop geofencing when it was never started', async () => {
      hasStartedGeofencing.mockResolvedValue(false);
      const monitor = new ExpoLocationMonitor();
      monitor.dispose();
      await Promise.resolve();
      await Promise.resolve();

      expect(stopGeofencing).not.toHaveBeenCalled();
    });

    it('does not throw when checking geofence status fails during disposal', async () => {
      hasStartedGeofencing.mockRejectedValue(new Error('native module torn down'));
      const monitor = new ExpoLocationMonitor();
      expect(() => monitor.dispose()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('app-state resync', () => {
    it('resyncs regions when the app becomes active with active watches', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      startGeofencing.mockClear();

      appStateHandler?.('active');
      await new Promise((resolve) => setImmediate(resolve));

      expect(startGeofencing).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the app becomes active with no watches', () => {
      new ExpoLocationMonitor();
      appStateHandler?.('active');
      expect(startGeofencing).not.toHaveBeenCalled();
    });

    it('ignores background/inactive transitions', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      startGeofencing.mockClear();

      appStateHandler?.('background');
      expect(startGeofencing).not.toHaveBeenCalled();
    });
  });

  describe('geofence task event routing', () => {
    it('ignores an event for a schedule with no active watch', async () => {
      const monitor = new ExpoLocationMonitor();
      const listener = jest.fn();
      await monitor.watch(request(), listener);
      listener.mockClear();

      taskListener?.({
        schedule_id: 'unknown-schedule',
        event: 'enter',
        latitude: 1,
        longitude: 2,
        radius: 100,
        observed_at: '2026-08-19T10:00:00.000Z',
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it('reports an exit sample offset outside the fence, not the raw region center', async () => {
      const monitor = new ExpoLocationMonitor();
      const listener = jest.fn();
      await monitor.watch(request(), listener);
      listener.mockClear();

      taskListener?.({
        schedule_id: 'schedule-1',
        event: 'exit',
        latitude: 31.2,
        longitude: 121.5,
        radius: 200,
        observed_at: '2026-08-19T10:00:00.000Z',
      });

      expect(listener).toHaveBeenCalledWith({
        schedule_id: 'schedule-1',
        sample: {
          latitude: 31.21,
          longitude: 121.5,
          accuracy_meters: 200,
          observed_at: '2026-08-19T10:00:00.000Z',
        },
        phase: 'left',
      });
    });
  });

  describe('syncRegions() permission checks', () => {
    it('skips registration when foreground permission is not granted', async () => {
      getForeground.mockResolvedValue(denied());
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());

      expect(requestForeground).not.toHaveBeenCalled();
      expect(requestBackground).not.toHaveBeenCalled();
      expect(startGeofencing).not.toHaveBeenCalled();
    });

    it('does not request background permission when foreground permission is missing', async () => {
      getForeground.mockResolvedValue(denied(false));
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());

      expect(requestBackground).not.toHaveBeenCalled();
      expect(startGeofencing).not.toHaveBeenCalled();
    });

    it('skips registration when background permission is not granted', async () => {
      getBackground.mockResolvedValue(denied());
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());

      expect(requestForeground).not.toHaveBeenCalled();
      expect(requestBackground).not.toHaveBeenCalled();
      expect(startGeofencing).not.toHaveBeenCalled();
    });

    it('does not request or register when background permission remains denied', async () => {
      getBackground.mockResolvedValue(denied(false));
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());

      expect(startGeofencing).not.toHaveBeenCalled();
    });

    it('does not re-request permission that is already granted', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());

      expect(requestForeground).not.toHaveBeenCalled();
      expect(requestBackground).not.toHaveBeenCalled();
    });

    it('warns and does not throw when startGeofencingAsync itself fails', async () => {
      startGeofencing.mockRejectedValue(new Error('system geofence limit reached'));
      const monitor = new ExpoLocationMonitor();
      await expect(monitor.watch(request(), jest.fn())).resolves.toBeDefined();
    });

    it('recovers after syncRegions() itself throws instead of leaving the sync chain stuck', async () => {
      // getForegroundPermissionsAsync/getBackgroundPermissionsAsync above are not
      // wrapped in try/catch, so a real native hiccup makes syncRegions() itself
      // reject (not just warn). chainSync() must neutralize that immediately --
      // handleAppState's resync is fire-and-forget (void this.chainSync()), so if
      // the rejection is left unhandled even briefly, Node/Hermes treats it as an
      // unhandled rejection and crashes the process outright (reproduced while
      // writing this test, before switching chainSync() to .then().catch(() => {})).
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      startGeofencing.mockClear();

      getForeground.mockRejectedValueOnce(new Error('native location module hiccup'));
      appStateHandler?.('active');
      await new Promise((resolve) => setImmediate(resolve));

      await expect(
        monitor.watch(request({ schedule_id: 'schedule-2' }), jest.fn()),
      ).resolves.toBeDefined();
      expect(startGeofencing).toHaveBeenCalled();
    });
  });
});
