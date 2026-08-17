import * as Location from 'expo-location';

import type { LocationSample } from '../../features/reminder/domain';

import type { LocationProvider } from './LocationProvider';

const LAST_KNOWN_MAX_AGE_MS = 60_000;
const LAST_KNOWN_REQUIRED_ACCURACY_METERS = 200;

/**
 * 真实定位实现。语音握手优先使用短时间内的缓存位置，避免等待 GPS 冷启动；同时
 * 在后台刷新当前位置，让下一次连接获得更新的位置。权限被拒绝或定位失败都返回
 * null 而不是抛错，调用方拿不到就不带 session.hello 的位置字段，不影响连通性。
 */
export class ExpoLocationProvider implements LocationProvider {
  private freshSampleInFlight: Promise<LocationSample | null> | null = null;

  async getCurrentSample(): Promise<LocationSample | null> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[location-search] foreground location permission is unavailable', { status });
      return null;
    }

    const cached = await this.getRecentSample();
    if (cached !== null) {
      void this.getFreshSample();
      return cached;
    }

    return this.getFreshSample();
  }

  private async getRecentSample(): Promise<LocationSample | null> {
    try {
      const position = await Location.getLastKnownPositionAsync({
        maxAge: LAST_KNOWN_MAX_AGE_MS,
        requiredAccuracy: LAST_KNOWN_REQUIRED_ACCURACY_METERS,
      });
      return position === null ? null : toSample(position);
    } catch (error) {
      console.warn('[location-search] failed to read cached location', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  private getFreshSample(): Promise<LocationSample | null> {
    if (this.freshSampleInFlight !== null) {
      return this.freshSampleInFlight;
    }

    const request = Location.getCurrentPositionAsync({})
      .then(toSample)
      .catch((error) => {
        console.warn('[location-search] failed to acquire current location', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
        return null;
      });
    this.freshSampleInFlight = request;
    void request.finally(() => {
      if (this.freshSampleInFlight === request) {
        this.freshSampleInFlight = null;
      }
    });
    return request;
  }
}

function toSample(position: Location.LocationObject): LocationSample {
  return {
    accuracy_meters: position.coords.accuracy ?? 0,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    observed_at: new Date(position.timestamp).toISOString(),
  };
}
