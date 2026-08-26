import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type {
  LocationMonitorEvent,
  LocationWatchRequest,
} from '../../../../src/features/reminder/application/interfaces';
import { ExpoLocationMonitor } from '../../../../src/infrastructure/location/ExpoLocationMonitor';

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  hasStartedGeofencingAsync: jest.fn(),
  stopGeofencingAsync: jest.fn(),
}));

jest.mock('expo-task-manager', () => ({
  isTaskRegisteredAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

const getForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
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
const isTaskRegistered = TaskManager.isTaskRegisteredAsync as jest.MockedFunction<
  typeof TaskManager.isTaskRegisteredAsync
>;
const unregisterTask = TaskManager.unregisterTaskAsync as jest.MockedFunction<
  typeof TaskManager.unregisterTaskAsync
>;

function granted(): Location.LocationPermissionResponse {
  return {
    status: 'granted' as Location.PermissionStatus,
    canAskAgain: true,
    granted: true,
    expires: 'never',
  };
}

function denied(): Location.LocationPermissionResponse {
  return {
    status: 'denied' as Location.PermissionStatus,
    canAskAgain: true,
    granted: false,
    expires: 'never',
  };
}

function request(overrides: Partial<LocationWatchRequest> = {}): LocationWatchRequest {
  return {
    schedule_id: 'schedule-1',
    center: { latitude: 31.2, longitude: 121.5 },
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

/** 让构造函数里那个 fire-and-forget 的清理跑完，再断言它调了什么。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ExpoLocationMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getForeground.mockResolvedValue(granted());
    getCurrentPosition.mockResolvedValue(position());
    hasStartedGeofencing.mockResolvedValue(false);
    stopGeofencing.mockResolvedValue(undefined);
    isTaskRegistered.mockResolvedValue(false);
    unregisterTask.mockResolvedValue(undefined);
  });

  describe('watch()', () => {
    it('registers a watch and delivers an initial inside sample', async () => {
      // 这条初始样本是这个类唯一主动送出的事件——它给 armed 状态机定起始值。
      // 之后的进出判定全部由 guard 心跳走 LocalReminderApplication.handleLocation()。
      const monitor = new ExpoLocationMonitor();
      const listener = jest.fn<(event: LocationMonitorEvent) => unknown>();

      const handle = await monitor.watch(request(), listener);

      expect(handle).toEqual({ listener_id: 'location-schedule-1', schedule_id: 'schedule-1' });
      expect(listener).toHaveBeenCalledWith({
        schedule_id: 'schedule-1',
        sample: {
          latitude: 31.2,
          longitude: 121.5,
          accuracy_meters: 12,
          observed_at: '2026-08-19T08:00:00.000Z',
        },
      });
    });

    it('never registers a system geofence', async () => {
      // 系统围栏已经整条删掉：它对判定零贡献（回调进来后代码伪造坐标重算），
      // 却会因为反复重注册重置 GMS 的状态机、丢掉真正的 enter。
      //
      // 这条的保证是结构性的，不靠断言调用次数：上面 expo-location 的 mock **故意
      // 不提供** startGeofencingAsync，所以源码里只要还残留一次调用，这里就会因为
      // "不是函数"直接抛错。watch() 正常 resolve 本身就是证据。
      expect('startGeofencingAsync' in Location).toBe(false);

      const monitor = new ExpoLocationMonitor();
      await expect(monitor.watch(request(), jest.fn())).resolves.toBeDefined();
      await flush();

      // 干净装机上不该碰 stopGeofencing——它只在清理老注册那条路径上出现。
      expect(stopGeofencing).not.toHaveBeenCalled();
    });

    it('does not deliver an initial sample when the current position is unavailable', async () => {
      getCurrentPosition.mockRejectedValue(new Error('no fix'));
      const monitor = new ExpoLocationMonitor();
      const listener = jest.fn();

      await monitor.watch(request(), listener);

      expect(listener).not.toHaveBeenCalled();
    });

    it('replaces an existing watch for the same schedule_id instead of stacking two', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      const second = await monitor.watch(request(), jest.fn());

      expect(second.listener_id).toBe('location-schedule-1');
      // 同一个 schedule 只留一条 watch：unwatch 一次就该彻底移除。
      await monitor.unwatch(second.listener_id);
      await expect(monitor.unwatch(second.listener_id)).resolves.toBeUndefined();
    });
  });

  describe('unwatch()', () => {
    it('does nothing for an unknown listener id', async () => {
      const monitor = new ExpoLocationMonitor();
      await expect(monitor.unwatch('location-nope')).resolves.toBeUndefined();
    });
  });

  describe('rebuild()', () => {
    it('replaces every watch and fans one sample out to all handles', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.watch(request(), jest.fn());
      getCurrentPosition.mockClear();
      const listener = jest.fn<(event: LocationMonitorEvent) => unknown>();

      const handles = await monitor.rebuild(
        [
          { schedule_id: 'a', center: { latitude: 1, longitude: 2 } },
          { schedule_id: 'b', center: { latitude: 3, longitude: 4 } },
        ],
        listener,
      );

      expect(handles.map((h) => h.schedule_id)).toEqual(['a', 'b']);
      // 只取一次定位再扇出，不是每个 target 各打一次定位请求。
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('drops the previous watches when rebuilt with no targets', async () => {
      const monitor = new ExpoLocationMonitor();
      const first = await monitor.watch(request(), jest.fn());

      await monitor.rebuild([], jest.fn());

      // 旧 watch 已经不在了，再 unwatch 一次是无害的空操作。
      await expect(monitor.unwatch(first.listener_id)).resolves.toBeUndefined();
    });
  });

  describe('getCurrentSample() / getLastSample()', () => {
    it('returns null before any sample has ever been taken', async () => {
      const monitor = new ExpoLocationMonitor();
      await expect(monitor.getLastSample()).resolves.toBeNull();
    });

    it('falls back to the last known sample when foreground permission is missing', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.getCurrentSample();
      getForeground.mockResolvedValue(denied());

      await expect(monitor.getCurrentSample()).resolves.toEqual(
        expect.objectContaining({ latitude: 31.2 }),
      );
    });

    it('falls back to the last known sample when the position read throws', async () => {
      const monitor = new ExpoLocationMonitor();
      await monitor.getCurrentSample();
      getCurrentPosition.mockRejectedValue(new Error('boom'));

      await expect(monitor.getCurrentSample()).resolves.toEqual(
        expect.objectContaining({ latitude: 31.2 }),
      );
    });

    it('defaults accuracy to 0 when the platform does not report it', async () => {
      getCurrentPosition.mockResolvedValue(position({ accuracy: null }));
      const monitor = new ExpoLocationMonitor();

      await expect(monitor.getCurrentSample()).resolves.toEqual(
        expect.objectContaining({ accuracy_meters: 0 }),
      );
    });
  });

  describe('legacy geofencing cleanup', () => {
    /**
     * 老装机上 'timeflow-geofence' 的注册被 expo-task-manager 持久化在
     * SharedPreferences 里，光删代码清不掉——那条 GMS 围栏会一直挂着、被唤醒时又
     * 找不到 JS 任务。所以构造时要主动停一次。
     */
    it('stops a leftover geofence registration and unregisters the legacy task', async () => {
      hasStartedGeofencing.mockResolvedValue(true);
      isTaskRegistered.mockResolvedValue(true);

      new ExpoLocationMonitor();
      await flush();

      expect(stopGeofencing).toHaveBeenCalledWith('timeflow-geofence');
      expect(unregisterTask).toHaveBeenCalledWith('timeflow-geofence');
    });

    it('does nothing when there is no leftover registration', async () => {
      new ExpoLocationMonitor();
      await flush();

      expect(stopGeofencing).not.toHaveBeenCalled();
      expect(unregisterTask).not.toHaveBeenCalled();
    });

    it('unregisters the task even when the geofence itself was already stopped', async () => {
      // stopGeofencingAsync 只解绑围栏，任务注册可能单独留着。
      hasStartedGeofencing.mockResolvedValue(false);
      isTaskRegistered.mockResolvedValue(true);

      new ExpoLocationMonitor();
      await flush();

      expect(stopGeofencing).not.toHaveBeenCalled();
      expect(unregisterTask).toHaveBeenCalledWith('timeflow-geofence');
    });

    it('swallows a cleanup failure instead of breaking construction', async () => {
      // 清理是收拾旧状态，不是功能路径——失败了地点提醒照样能用（判定全在 guard 那条链上）。
      hasStartedGeofencing.mockRejectedValue(new Error('native module gone'));

      const monitor = new ExpoLocationMonitor();
      await flush();

      await expect(monitor.watch(request(), jest.fn())).resolves.toEqual(
        expect.objectContaining({ schedule_id: 'schedule-1' }),
      );
    });
  });
});
