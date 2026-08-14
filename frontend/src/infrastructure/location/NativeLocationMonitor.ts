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

import type { LocationProvider } from './LocationProvider';
import {
  baiduGetCurrentPosition,
  baiduInit,
  baiduStartUpdating,
  baiduStopUpdating,
  isBaiduLocationAvailable,
  subscribeBaiduLocation,
  type BaiduLocationSample,
} from './native/BaiduLocationBridge';

type ActiveWatch = {
  listener_id: string;
  request: LocationWatchRequest;
  listener: (event: LocationMonitorEvent) => void;
  inside: boolean | null;
};

/**
 * 基于百度定位 SDK 的围栏/定位适配器：
 * - 连续定位采样（非 Google Geofencing）
 * - 应用侧 Haversine 计算进出圈边沿
 */
export class NativeLocationMonitor implements LocationMonitorPort, LocationProvider {
  private readonly watches = new Map<string, ActiveWatch>();
  private readonly scheduleToListener = new Map<string, string>();
  private lastSample: LocationSample | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private unsubscribeLocation: (() => void) | null = null;
  private started = false;
  private readonly appStateSub: NativeEventSubscription;

  constructor() {
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
    if (!isBaiduLocationAvailable()) return this.lastSample;
    try {
      if (!this.started) {
        await baiduInit(null);
      }
      const current = await baiduGetCurrentPosition();
      if (current == null) return this.lastSample;
      const sample = toSample(current);
      this.lastSample = sample;
      return sample;
    } catch {
      return this.lastSample;
    }
  }

  dispose(): void {
    this.unsubscribeLocation?.();
    this.unsubscribeLocation = null;
    this.appStateSub.remove();
    void baiduStopUpdating();
    this.started = false;
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
    if (this.watches.size === 0) {
      this.unsubscribeLocation?.();
      this.unsubscribeLocation = null;
      if (this.started) {
        await baiduStopUpdating();
        this.started = false;
      }
      return;
    }

    if (!isBaiduLocationAvailable()) {
      return;
    }

    if (this.unsubscribeLocation == null) {
      this.unsubscribeLocation = subscribeBaiduLocation((payload) => {
        const sample = toSample(payload);
        this.lastSample = sample;
        for (const watch of this.watches.values()) {
          this.emitForWatch(watch, sample, false);
        }
      });
    }

    await baiduInit(null);
    await baiduStartUpdating(5_000);
    this.started = true;
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

function toSample(payload: BaiduLocationSample): LocationSample {
  return {
    latitude: payload.latitude,
    longitude: payload.longitude,
    accuracy_meters: payload.accuracy ?? 0,
    observed_at: payload.observedAt || new Date().toISOString(),
  };
}
