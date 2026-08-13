import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import type {
  LocationMonitorEvent,
  LocationMonitorPort,
  LocationRebuildTarget,
  LocationWatchHandle,
  LocationWatchRequest,
} from '../../features/reminder/application/interfaces';
import type { LocationSample } from '../../features/reminder/domain';
import { distanceMeters } from '../../features/reminder/domain/geofence';
import type { LocationObservation } from '../../contracts/reminder';

import {
  GEOFENCE_TASK_NAME,
  subscribeGeofenceTaskEvents,
  type GeofenceTaskPayload,
} from './geofenceTask';
import type { LocationProvider } from './LocationProvider';

type ActiveWatch = {
  listener_id: string;
  request: LocationWatchRequest;
  listener: (event: LocationMonitorEvent) => void;
  inside: boolean | null;
};

type LocationModule = typeof import('expo-location');
type PositionSubscription = { remove: () => void };

/**
 * 基于 expo-location 的围栏/定位适配器：
 * - 有后台定位权限时走系统 geofencing
 * - 否则退化为前台 watchPosition + Haversine 边沿检测
 */
export class NativeLocationMonitor implements LocationMonitorPort, LocationProvider {
  private readonly watches = new Map<string, ActiveWatch>();
  private readonly scheduleToListener = new Map<string, string>();
  private lastSample: LocationSample | null = null;
  private positionSub: PositionSubscription | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private readonly unsubscribeTask: () => void;
  private readonly appStateSub: NativeEventSubscription;

  constructor() {
    this.unsubscribeTask = subscribeGeofenceTaskEvents((payload) => {
      this.handleGeofenceTask(payload);
    });
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
    this.watches.set(listener_id, {
      listener_id,
      request: { ...request },
      listener,
      inside: null,
    });
    this.scheduleToListener.set(request.schedule_id, listener_id);
    await this.enqueueSync();

    const sample = await this.getCurrentSample();
    const watch = this.watches.get(listener_id);
    if (sample != null && watch != null) {
      this.emitForWatch(watch, sample, /*forcePhase*/ true);
    }

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
    await this.enqueueSync();

    const handles: LocationWatchHandle[] = [];
    for (const target of targets) {
      handles.push(
        await this.watch(
          {
            schedule_id: target.schedule_id,
            center: target.center,
            radius_meters: target.radius_meters,
            mode: target.mode,
            background: target.background,
          },
          listener,
        ),
      );
    }
    return handles;
  }

  async getLastSample(): Promise<LocationSample | null> {
    return this.lastSample;
  }

  async getCurrentSample(): Promise<LocationObservation | null> {
    const Location = await loadExpoLocation();
    if (Location == null) return this.lastSample;

    try {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== 'granted') return this.lastSample;

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const sample = toSample(position);
      this.lastSample = sample;
      return sample;
    } catch {
      return this.lastSample;
    }
  }

  dispose(): void {
    this.unsubscribeTask();
    this.appStateSub.remove();
  }

  private readonly handleAppState = (state: AppStateStatus): void => {
    if (state !== 'active' || this.watches.size === 0) return;
    void this.enqueueSync();
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
      () => this.syncMonitoring(),
      () => this.syncMonitoring(),
    );
    return this.syncChain;
  }

  private async syncMonitoring(): Promise<void> {
    const Location = await loadExpoLocation();
    if (Location == null) {
      await this.stopPositionWatch();
      return;
    }

    const regions = [...this.watches.values()].map((watch) => ({
      identifier: watch.request.schedule_id,
      latitude: watch.request.center.latitude,
      longitude: watch.request.center.longitude,
      radius: Math.max(watch.request.radius_meters, 1),
      notifyOnEnter: true,
      notifyOnExit: true,
    }));

    if (regions.length === 0) {
      await stopGeofencingIfStarted(Location);
      await this.stopPositionWatch();
      return;
    }

    const foreground = await Location.getForegroundPermissionsAsync();
    if (foreground.status !== 'granted') {
      await stopGeofencingIfStarted(Location);
      await this.stopPositionWatch();
      return;
    }

    const wantsBackground = [...this.watches.values()].some((watch) => watch.request.background);
    const background = await Location.getBackgroundPermissionsAsync();
    const canGeofence = wantsBackground && background.status === 'granted';

    if (canGeofence) {
      await this.stopPositionWatch();
      await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, regions);
      return;
    }

    await stopGeofencingIfStarted(Location);
    await this.ensurePositionWatch(Location);
  }

  private async ensurePositionWatch(Location: LocationModule): Promise<void> {
    if (this.positionSub != null) return;
    this.positionSub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        distanceInterval: 25,
        timeInterval: 5_000,
      },
      (position) => {
        const sample = toSample(position);
        this.lastSample = sample;
        for (const watch of this.watches.values()) {
          this.emitForWatch(watch, sample, false);
        }
      },
    );
  }

  private async stopPositionWatch(): Promise<void> {
    this.positionSub?.remove();
    this.positionSub = null;
  }

  private handleGeofenceTask(payload: GeofenceTaskPayload): void {
    const listenerId = this.scheduleToListener.get(payload.schedule_id);
    if (listenerId == null) return;
    const watch = this.watches.get(listenerId);
    if (watch == null) return;

    const sample: LocationSample = {
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy_meters: payload.radius,
      observed_at: payload.observed_at,
    };
    this.lastSample = sample;
    watch.inside = payload.event === 'enter';
    watch.listener({
      schedule_id: payload.schedule_id,
      sample,
      phase: payload.event === 'enter' ? 'entered' : 'left',
    });
  }

  private emitForWatch(watch: ActiveWatch, sample: LocationSample, forcePhase: boolean): void {
    const inside = distanceMeters(watch.request.center, sample) <= watch.request.radius_meters;
    const previous = watch.inside;
    watch.inside = inside;

    let phase: LocationMonitorEvent['phase'];
    if (previous == null || forcePhase) {
      phase = inside ? 'inside' : 'outside';
    } else if (previous === inside) {
      phase = inside ? 'inside' : 'outside';
    } else {
      phase = inside ? 'entered' : 'left';
    }

    if (!forcePhase && previous === inside) {
      return;
    }

    watch.listener({
      schedule_id: watch.request.schedule_id,
      sample,
      phase,
    });
  }
}

function toSample(position: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
}): LocationSample {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy_meters: position.coords.accuracy ?? 0,
    observed_at: new Date(position.timestamp).toISOString(),
  };
}

/** hasStartedGeofencingAsync 在无后台定位权限时会抛错，不能直接调用。 */
async function stopGeofencingIfStarted(Location: LocationModule): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
    }
  } catch {
    // 无后台定位权限时视为未启动。
  }
}

async function loadExpoLocation(): Promise<LocationModule | null> {
  try {
    return await import('expo-location');
  } catch {
    return null;
  }
}
