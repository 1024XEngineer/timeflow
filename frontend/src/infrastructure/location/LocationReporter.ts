import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import type { LocationReport, LocationReportAck, Schedule, WsJsonMessage } from '@/contracts';
import { nextRequestId } from '@/shared/utils/requestId';

export type LocationSample = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp?: string;
};

export type LocationProvider = {
  getCurrentSample(): Promise<LocationSample | null>;
};

export type LocationTransport = {
  request<T extends WsJsonMessage>(
    message: WsJsonMessage & { request_id: string },
    isMatch?: (response: WsJsonMessage) => boolean,
  ): Promise<T>;
};

export class LocationUnavailableError extends Error {
  constructor(message = '当前位置服务不可用') {
    super(message);
    this.name = 'LocationUnavailableError';
  }
}

type ExpoLocationPosition = {
  coords?: {
    latitude?: number;
    longitude?: number;
    accuracy?: number | null;
  };
  timestamp?: number;
};

type ExpoLocationPermission = {
  status?: string;
  granted?: boolean;
};

type ExpoLocationModule = {
  getForegroundPermissionsAsync?: () => Promise<ExpoLocationPermission>;
  requestForegroundPermissionsAsync?: () => Promise<ExpoLocationPermission>;
  getCurrentPositionAsync?: (options?: Record<string, unknown>) => Promise<ExpoLocationPosition>;
};

// Expo Location's public enum maps Balanced accuracy to 3. Keep the numeric
// value at this adapter boundary so the feature does not depend on the SDK.
const EXPO_BALANCED_ACCURACY = 3;

function assertSample(sample: LocationSample): LocationSample {
  if (
    !Number.isFinite(sample.latitude) ||
    sample.latitude < -90 ||
    sample.latitude > 90 ||
    !Number.isFinite(sample.longitude) ||
    sample.longitude < -180 ||
    sample.longitude > 180 ||
    !Number.isFinite(sample.accuracy) ||
    sample.accuracy < 0
  ) {
    throw new LocationUnavailableError('定位 SDK 返回了无效坐标');
  }
  return sample;
}

function isGranted(permission: ExpoLocationPermission | null | undefined): boolean {
  return permission?.granted === true || permission?.status === 'granted';
}

/** Native Expo location provider. The module must be linked by the host build. */
export class ExpoLocationProvider implements LocationProvider {
  constructor(
    private readonly module: ExpoLocationModule | null = requireOptionalNativeModule<ExpoLocationModule>(
      'ExpoLocation',
    ),
  ) {}

  async getCurrentSample(): Promise<LocationSample | null> {
    const location = this.module;
    if (!location?.getCurrentPositionAsync) {
      throw new LocationUnavailableError(
        'ExpoLocation 原生模块未链接；请在宿主中注入 LocationProvider',
      );
    }

    const currentPermission = await location.getForegroundPermissionsAsync?.();
    const permission = isGranted(currentPermission)
      ? currentPermission
      : await location.requestForegroundPermissionsAsync?.();
    if (!isGranted(permission)) {
      throw new LocationUnavailableError('未授予前台定位权限');
    }

    const position = await location.getCurrentPositionAsync({
      accuracy: EXPO_BALANCED_ACCURACY,
    });
    const latitude = position.coords?.latitude;
    const longitude = position.coords?.longitude;
    if (latitude == null || longitude == null) {
      throw new LocationUnavailableError('定位 SDK 未返回坐标');
    }
    return assertSample({
      latitude,
      longitude,
      accuracy: Math.max(0, position.coords?.accuracy ?? 0),
      timestamp:
        position.timestamp != null
          ? new Date(position.timestamp).toISOString()
          : new Date().toISOString(),
    });
  }
}

/** Browser provider used by RN Web and desktop development. */
export class BrowserLocationProvider implements LocationProvider {
  async getCurrentSample(): Promise<LocationSample | null> {
    const geolocation = globalThis.navigator?.geolocation;
    if (!geolocation) {
      throw new LocationUnavailableError('当前浏览器不支持定位');
    }
    return new Promise<LocationSample | null>((resolve, reject) => {
      geolocation.getCurrentPosition(
        (position) => {
          try {
            resolve(
              assertSample({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: Math.max(0, position.coords.accuracy ?? 0),
                timestamp: new Date(position.timestamp).toISOString(),
              }),
            );
          } catch (error) {
            reject(error);
          }
        },
        (error) => reject(new LocationUnavailableError(`定位失败: ${error.message}`)),
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 },
      );
    });
  }
}

/**
 * Resolve the platform provider at the composition boundary. No fixed
 * coordinates are ever returned: an unavailable native module is surfaced as
 * an error and the reporter skips that tick.
 */
export function createLocationProvider(): LocationProvider {
  return Platform.OS === 'web' ? new BrowserLocationProvider() : new ExpoLocationProvider();
}

type LocationSampleSource = LocationProvider | (() => Promise<LocationSample | null>);

function readSample(source: LocationSampleSource): Promise<LocationSample | null> {
  return typeof source === 'function' ? source() : source.getCurrentSample();
}

/**
 * 地点提醒位置上报器：客户端只上报位置，触发判定留给服务端。
 * 当前 timer 是前台轮询；后台 task/围栏应由宿主注入更合适的 provider。
 */
export class LocationReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private armed = false;
  private tickInFlight = false;
  private lastError: Error | null = null;

  constructor(
    private readonly client: LocationTransport,
    private readonly source: LocationSampleSource,
    private readonly onError?: (error: Error) => void,
  ) {}

  getLastError(): Error | null {
    return this.lastError;
  }

  syncArmedSchedules(schedules: Schedule[]): void {
    this.armed = schedules.some(
      (item) =>
        item.status === 'scheduled' && item.schedule_type === 'location' && item.geofence_armed,
    );
    if (this.armed) {
      this.start(30_000);
    } else {
      this.stop();
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.armed = true;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    this.armed = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async report(sample: LocationSample): Promise<LocationReportAck> {
    const validated = assertSample(sample);
    const message: LocationReport = {
      type: 'location.report',
      request_id: nextRequestId('req_location'),
      payload: {
        schedule_scope: 'current',
        latitude: validated.latitude,
        longitude: validated.longitude,
        accuracy: validated.accuracy,
        timestamp: validated.timestamp ?? new Date().toISOString(),
      },
    };
    const isMatch = (incoming: WsJsonMessage) =>
      incoming.type === 'location.report.ack' && incoming.request_id === message.request_id;

    const ack = await this.client.request<LocationReportAck>(message, isMatch);
    if (!ack.ok) {
      throw new Error(ack.error.message);
    }
    return ack;
  }

  private async tick(): Promise<void> {
    if (!this.armed || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const sample = await readSample(this.source);
      if (!sample || !this.armed) return;
      await this.report(sample);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      this.onError?.(this.lastError);
    } finally {
      this.tickInFlight = false;
    }
  }
}
