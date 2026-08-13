import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

import { useLocationPermissionsOnLaunch } from '../../../../src/features/reminder/presentation/useLocationPermissionsOnLaunch';

jest.mock('expo-location', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied' },
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestBackgroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
}));

type LocationMock = {
  requestForegroundPermissionsAsync: jest.MockedFunction<() => Promise<{ status: string }>>;
  requestBackgroundPermissionsAsync: jest.MockedFunction<() => Promise<{ status: string }>>;
};

function locationMock(): LocationMock {
  return jest.requireMock('expo-location') as LocationMock;
}

describe('useLocationPermissionsOnLaunch', () => {
  beforeEach(() => {
    const location = locationMock();
    location.requestForegroundPermissionsAsync.mockReset();
    location.requestBackgroundPermissionsAsync.mockReset();
    location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  });

  it('requests foreground then background location on launch', async () => {
    const location = locationMock();
    renderHook(() => useLocationPermissionsOnLaunch());
    await waitFor(() => {
      expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(location.requestBackgroundPermissionsAsync).toHaveBeenCalledTimes(1);
    });
  });

  it('skips background request when foreground is denied', async () => {
    const location = locationMock();
    location.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });
    renderHook(() => useLocationPermissionsOnLaunch());
    await waitFor(() => {
      expect(location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    });
    expect(location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });
});
