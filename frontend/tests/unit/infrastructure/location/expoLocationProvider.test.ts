import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';

import { ExpoLocationProvider } from '../../../../src/infrastructure/location/ExpoLocationProvider';

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

const getForeground = Location.getForegroundPermissionsAsync as jest.MockedFunction<
  typeof Location.getForegroundPermissionsAsync
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
    getLastKnown.mockResolvedValue(null);
    getCurrent.mockRejectedValue(new Error('GPS unavailable'));
  });

  it('reads location without opening a permission prompt', async () => {
    const provider = new ExpoLocationProvider();

    await expect(provider.getCurrentSample()).resolves.toBeNull();

    expect(getForeground).toHaveBeenCalledTimes(1);
    expect(getLastKnown).toHaveBeenCalledTimes(1);
  });
});
