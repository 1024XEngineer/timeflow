import * as Location from 'expo-location';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import type {
  LocationMonitorEvent,
  LocationMonitorPort,
  LocationRebuildTarget,
  LocationWatchHandle,
  LocationWatchRequest,
} from '../../features/reminder/application/interfaces';
import type { LocationSample } from '../../features/reminder/domain';

import {
  GEOFENCE_TASK_NAME,
  drainPendingGeofenceEvents,
  subscribeGeofenceTaskEvents,
  type GeofenceTaskPayload,
} from './geofenceTask';
import type { LocationProvider } from './LocationProvider';

type ActiveWatch = {
  listener_id: string;
  request: LocationWatchRequest;
  listener: (event: LocationMonitorEvent) => void;
};

/** ≈1.1km，足够超出任何合理的围栏半径，用来给 exit 事件合成一个"明显在圈外"的采样点。 */
const OUTSIDE_OFFSET_DEGREES = 0.01;

/**
 * 基于 expo-location 系统原生地理围栏（Android GeofencingClient / iOS
 * CLCircularRegion）的适配器：不依赖百度账号/Key，围栏进出判断交给系统，比
 * NativeLocationMonitor 那套连续定位轮询 + 应用侧 Haversine 更省电、后台也更可靠。
 *
 * 系统只会在真正穿越边界时回调 enter/exit，不会在注册那一刻告诉你当前在圈内还是圈
 * 外，所以 watch() 里仍然主动取一次当前定位、强制送一条初始采样，让
 * LocalReminderApplication 的 armed 状态机能定出正确的起始值；之后的进出全靠
 * geofenceTask 的系统回调，不再轮询。
 *
 * LocalReminderApplication.applyLocationSample() 不看这里传的 phase，只用 sample
 * 坐标自己重新跑一遍 Haversine 判断，所以 enter/exit 时合成的坐标（区域中心 /
 * 中心外一段距离）足够，不需要为了拿"真实"坐标再多发一次定位请求。
 */
export class ExpoLocationMonitor implements LocationMonitorPort, LocationProvider {
  private readonly watches = new Map<string, ActiveWatch>();
  private readonly scheduleToListener = new Map<string, string>();
  private lastSample: LocationSample | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private unsubscribeTask: (() => void) | null;
  private readonly appStateSub: NativeEventSubscription;

  constructor() {
    this.unsubscribeTask = subscribeGeofenceTaskEvents(this.handleTaskEvent);
    this.appStateSub = AppState.addEventListener('change', this.handleAppState);
  }

  async watch(
    request: LocationWatchRequest,
    listener: (event: LocationMonitorEvent) => void,
  ): Promise<LocationWatchHandle> {
    const existingId = this.scheduleToListener.get(request.schedule_id);
    if (existingId != null) {
      await this.removeWatch(existingId, false);
    }

    const listener_id = `location-${request.schedule_id}`;
    this.watches.set(listener_id, { listener_id, request: { ...request }, listener });
    this.scheduleToListener.set(request.schedule_id, listener_id);
    await this.enqueueSync();

    const sample = await this.getCurrentSample();
    if (sample != null) {
      listener({ schedule_id: request.schedule_id, sample, phase: 'inside' });
    }
    await this.replayPendingEvents();

    return { listener_id, schedule_id: request.schedule_id };
  }

  async unwatch(listenerId: string): Promise<void> {
    await this.removeWatch(listenerId, true);
  }

  async rebuild(
    targets: readonly LocationRebuildTarget[],
    listener: (event: LocationMonitorEvent) => void,
  ): Promise<readonly LocationWatchHandle[]> {
    for (const listenerId of [...this.watches.keys()]) {
      await this.removeWatch(listenerId, false);
    }

    // 直接灌 Map，不逐个调用 watch()：watch() 自己的 enqueueSync()+getCurrentSample()
    // 是为单条增量注册设计的，N 个 target 各跑一次会把 startGeofencingAsync 的区域
    // 列表越注册越长（O(N²) 总区域数）、定位请求也打 N 次；这里全部灌完只同步一次、
    // 取一次定位，再扇给每个刚注册的 watch。
    const handles: LocationWatchHandle[] = [];
    for (const target of targets) {
      const listener_id = `location-${target.schedule_id}`;
      this.watches.set(listener_id, {
        listener_id,
        request: {
          schedule_id: target.schedule_id,
          center: target.center,
          radius_meters: target.radius_meters,
          mode: target.mode,
          background: target.background,
        },
        listener,
      });
      this.scheduleToListener.set(target.schedule_id, listener_id);
      handles.push({ listener_id, schedule_id: target.schedule_id });
    }
    await this.enqueueSync();

    const sample = await this.getCurrentSample();
    if (sample != null) {
      for (const handle of handles) {
        listener({ schedule_id: handle.schedule_id, sample, phase: 'inside' });
      }
    }

    // App 进程被杀掉期间，headless task 攒下的围栏事件在这里补上——watches/
    // scheduleToListener 刚灌好，handleTaskEvent 才查得到对应的 watch。
    await this.replayPendingEvents();

    return handles;
  }

  async getLastSample(): Promise<LocationSample | null> {
    return this.lastSample;
  }

  async getCurrentSample(): Promise<LocationSample | null> {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return this.lastSample;
      const position = await Location.getCurrentPositionAsync({});
      const sample = toSample(position);
      this.lastSample = sample;
      return sample;
    } catch {
      return this.lastSample;
    }
  }

  dispose(): void {
    this.unsubscribeTask?.();
    this.unsubscribeTask = null;
    this.appStateSub.remove();
    void Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME)
      .then((started) => (started ? Location.stopGeofencingAsync(GEOFENCE_TASK_NAME) : undefined))
      .catch(() => undefined);
  }

  private readonly handleAppState = (state: AppStateStatus): void => {
    if (state !== 'active' || this.watches.size === 0) return;
    void this.enqueueSync();
  };

  /** 补上 headless task 期间（没有订阅者时）攒下的围栏事件，按正常路径重放一遍。 */
  private async replayPendingEvents(): Promise<void> {
    const pending = await drainPendingGeofenceEvents();
    for (const payload of pending) {
      this.handleTaskEvent(payload);
    }
  }

  private readonly handleTaskEvent = (payload: GeofenceTaskPayload): void => {
    const listenerId = this.scheduleToListener.get(payload.schedule_id);
    const watch = listenerId != null ? this.watches.get(listenerId) : undefined;
    if (watch == null) return;

    const sample: LocationSample =
      payload.event === 'enter'
        ? {
            latitude: payload.latitude,
            longitude: payload.longitude,
            accuracy_meters: payload.radius,
            observed_at: payload.observed_at,
          }
        : {
            latitude: payload.latitude + OUTSIDE_OFFSET_DEGREES,
            longitude: payload.longitude,
            accuracy_meters: payload.radius,
            observed_at: payload.observed_at,
          };
    this.lastSample = sample;
    watch.listener({
      schedule_id: watch.request.schedule_id,
      sample,
      phase: payload.event === 'enter' ? 'entered' : 'left',
    });
  };

  private async removeWatch(listenerId: string, sync: boolean): Promise<void> {
    const watch = this.watches.get(listenerId);
    if (watch == null) return;
    this.watches.delete(listenerId);
    this.scheduleToListener.delete(watch.request.schedule_id);
    if (sync) {
      await this.enqueueSync();
    }
  }

  private enqueueSync(): Promise<void> {
    this.syncChain = this.syncChain.then(
      () => this.syncRegions(),
      () => this.syncRegions(),
    );
    return this.syncChain;
  }

  private async syncRegions(): Promise<void> {
    if (this.watches.size === 0) {
      const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME).catch(
        () => false,
      );
      if (started) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME).catch(() => undefined);
      }
      return;
    }

    const { status: foreground } = await Location.getForegroundPermissionsAsync();
    if (foreground !== 'granted') return;
    const { status: background } = await Location.getBackgroundPermissionsAsync();
    if (background !== 'granted') return;

    const regions: Location.LocationRegion[] = [...this.watches.values()].map((watch) => ({
      identifier: watch.request.schedule_id,
      latitude: watch.request.center.latitude,
      longitude: watch.request.center.longitude,
      radius: watch.request.radius_meters,
      notifyOnEnter: true,
      notifyOnExit: true,
    }));

    try {
      await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, regions);
    } catch {
      // 系统围栏注册失败（比如权限被收回）；下次 watch()/rebuild() 会再重试。
    }
  }
}

function toSample(position: Location.LocationObject): LocationSample {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_meters: position.coords.accuracy ?? 0,
    observed_at: new Date(position.timestamp).toISOString(),
  };
}
