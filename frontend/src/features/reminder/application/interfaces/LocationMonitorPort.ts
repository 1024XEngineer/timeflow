import type { GeoPoint, LocationSample } from '../../domain';

export type LocationWatchMode = 'arrive' | 'return';

/**
 * 围栏重建目标：携带 watch 所需几何参数，避免 infrastructure 依赖完整领域日程，
 * 同时保证冷启动 rebuild 能重新挂上系统围栏。
 */
export type LocationRebuildTarget = {
  schedule_id: string;
  center: GeoPoint;
  radius_meters: number;
  mode: LocationWatchMode;
  background: boolean;
};

export type LocationWatchRequest = {
  schedule_id: string;
  center: GeoPoint;
  radius_meters: number;
  mode: LocationWatchMode;
  background: boolean;
};

export type LocationWatchHandle = {
  listener_id: string;
  schedule_id: string;
};

export type LocationMonitorEvent = {
  schedule_id: string;
  sample: LocationSample;
  phase: 'inside' | 'outside' | 'entered' | 'left';
};

/** 定位采样和系统围栏能力；此处不做提醒触发判断。 */
export interface LocationMonitorPort {
  watch(
    request: LocationWatchRequest,
    listener: (event: LocationMonitorEvent) => void,
  ): Promise<LocationWatchHandle>;
  unwatch(listenerId: string): Promise<void>;
  rebuild(
    targets: readonly LocationRebuildTarget[],
    listener: (event: LocationMonitorEvent) => void,
  ): Promise<readonly LocationWatchHandle[]>;
  getLastSample(): Promise<LocationSample | null>;
}
