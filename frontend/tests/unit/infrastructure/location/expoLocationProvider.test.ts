import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';

import { ExpoLocationProvider } from '../../../../src/infrastructure/location/ExpoLocationProvider';

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

const getForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
>;
const requestForeground = Location.requestForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.requestForegroundPermissionsAsync
>;
const getLastKnown = Location.getLastKnownPositionAsync as jest.MockedFunction<
  typeof Location.getLastKnownPositionAsync
>;
const getCurrent = Location.getCurrentPositionAsync as jest.MockedFunction<
  typeof Location.getCurrentPositionAsync
>;

function granted(): Location.LocationPermissionResponse {
  return {
    status: 'granted' as Location.PermissionStatus,
    canAskAgain: true,
    granted: true,
    expires: 'never',
  };
}

describe('ExpoLocationProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getForeground.mockResolvedValue(granted());
    requestForeground.mockResolvedValue(granted());
    getLastKnown.mockResolvedValue(null);
    getCurrent.mockResolvedValue({
      coords: {
        accuracy: 16,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        latitude: 31.2304,
        longitude: 121.4737,
        speed: null,
      },
      timestamp: Date.parse('2026-08-20T09:00:00.000Z'),
    });
  });

  it('reads location without opening a permission prompt', async () => {
    getCurrent.mockRejectedValueOnce(new Error('GPS unavailable'));
    const provider = new ExpoLocationProvider({ nativeFallback: async () => null });

    await expect(provider.getCurrentSample()).resolves.toBeNull();

    expect(getForeground).toHaveBeenCalledTimes(1);
    expect(requestForeground).not.toHaveBeenCalled();
    expect(getLastKnown).toHaveBeenCalledTimes(1);
  });

  it('uses the native Android cached location when Expo has no cached position', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const nativeFallback = jest.fn(async () => ({
      accuracy_meters: 30,
      latitude: 31.187169,
      longitude: 121.605098,
      observed_at: '2026-08-20T09:37:26.000Z',
    }));
    const provider = new ExpoLocationProvider({ nativeFallback });

    await expect(provider.getCurrentSample()).resolves.toEqual({
      accuracy_meters: 30,
      latitude: 31.187169,
      longitude: 121.605098,
      observed_at: '2026-08-20T09:37:26.000Z',
    });
    expect(nativeFallback).toHaveBeenCalledTimes(1);
    expect(getCurrent).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('falls back to Expo current position when native cached location is unavailable', async () => {
    const provider = new ExpoLocationProvider({ nativeFallback: async () => null });

    await expect(provider.getCurrentSample()).resolves.toEqual({
      accuracy_meters: 16,
      latitude: 31.2304,
      longitude: 121.4737,
      observed_at: '2026-08-20T09:00:00.000Z',
    });
  });

  it('falls back to Expo current position when native cached location throws', async () => {
    const nativeFallback = jest.fn(async (): Promise<null> => {
      throw new Error('native location unavailable');
    });
    const provider = new ExpoLocationProvider({ nativeFallback });

    await expect(provider.getCurrentSample()).resolves.toEqual({
      accuracy_meters: 16,
      latitude: 31.2304,
      longitude: 121.4737,
      observed_at: '2026-08-20T09:00:00.000Z',
    });
    expect(nativeFallback).toHaveBeenCalledTimes(1);
  });
});
