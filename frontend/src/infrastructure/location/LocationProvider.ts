import type { LocationSample } from '../../features/reminder/domain';

/** 获取一次当前位置样本的平台适配器。 */
export interface LocationProvider {
  getCurrentSample(): Promise<LocationSample | null>;
}
