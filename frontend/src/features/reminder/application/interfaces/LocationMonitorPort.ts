import type { GeoPoint, LocalReminderSchedule, LocationSample } from '../../domain';

export type LocationWatchMode = 'arrive' | 'return';

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
    schedules: readonly LocalReminderSchedule[],
    listener: (event: LocationMonitorEvent) => void,
  ): Promise<readonly LocationWatchHandle[]>;
  getLastSample(): Promise<LocationSample | null>;
}
