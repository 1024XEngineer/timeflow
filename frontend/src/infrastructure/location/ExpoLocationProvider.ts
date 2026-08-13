import * as Location from 'expo-location';

import type { LocationSample } from '../../features/reminder/domain';

import type { LocationProvider } from './LocationProvider';

/**
 * 真实定位实现。权限被拒绝或定位失败都返回 null 而不是抛错——调用方（目前是
 * session.hello 的位置字段）拿不到就不带这个字段，不应该因为定位失败连不上。
 */
export class ExpoLocationProvider implements LocationProvider {
  async getCurrentSample(): Promise<LocationSample | null> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return null;
    }

    try {
      const position = await Location.getCurrentPositionAsync({});
      return {
        accuracy_meters: position.coords.accuracy ?? 0,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        observed_at: new Date(position.timestamp).toISOString(),
      };
    } catch {
      return null;
    }
  }
}
