import type { LocationObservation } from '../../contracts/reminder';

/** 获取一次当前位置样本的平台适配器。 */
export interface LocationProvider {
  getCurrentSample(): Promise<LocationObservation | null>;
}
