import { NativeModules } from 'react-native';

import type { LocationObservation } from '../../contracts/reminder';

type NativeLocationPayload = {
  accuracyMeters?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  observedAtMillis?: unknown;
  provider?: unknown;
};

type TimeflowLocationModule = {
  getLastKnownLocation?: () => Promise<NativeLocationPayload | null>;
};

export async function getNativeLastKnownLocationSample(): Promise<LocationObservation | null> {
  const module = NativeModules.TimeflowLocation as TimeflowLocationModule | undefined;
  if (typeof module?.getLastKnownLocation !== 'function') {
    return null;
  }

  try {
    return toObservation(await module.getLastKnownLocation());
  } catch (error) {
    console.warn('[location-search] native cached location failed', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

function toObservation(payload: NativeLocationPayload | null): LocationObservation | null {
  if (payload === null) {
    return null;
  }

  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const observedAtMillis = payload.observedAtMillis;
  if (
    !isFiniteNumber(latitude) ||
    !isFiniteNumber(longitude) ||
    !isFiniteNumber(observedAtMillis) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const accuracyMeters = isFiniteNumber(payload.accuracyMeters)
    ? Math.max(0, payload.accuracyMeters)
    : 0;
  return {
    accuracy_meters: accuracyMeters,
    latitude,
    longitude,
    observed_at: new Date(observedAtMillis).toISOString(),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
