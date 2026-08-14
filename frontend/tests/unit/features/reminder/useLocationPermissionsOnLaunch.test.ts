import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, Platform } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';

import { useLocationPermissionsOnLaunch } from '../../../../src/features/reminder/presentation/useLocationPermissionsOnLaunch';
import {
  baiduSetAgreePrivacy,
  persistBaiduPrivacyConsent,
  readBaiduPrivacyConsent,
} from '../../../../src/infrastructure/location/native/BaiduLocationBridge';

jest.mock('expo-location', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied' },
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestBackgroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
}));

jest.mock('../../../../src/infrastructure/location/native/BaiduLocationBridge', () => ({
  baiduSetAgreePrivacy: jest.fn(async () => undefined),
  persistBaiduPrivacyConsent: jest.fn(async () => undefined),
  readBaiduPrivacyConsent: jest.fn(async () => false),
}));

type LocationMock = {
  requestForegroundPermissionsAsync: jest.MockedFunction<() => Promise<{ status: string }>>;
  requestBackgroundPermissionsAsync: jest.MockedFunction<() => Promise<{ status: string }>>;
};

function locationMock(): LocationMock {
  return jest.requireMock('expo-location') as LocationMock;
}

describe('useLocationPermissionsOnLaunch', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'android';
    const location = locationMock();
    location.requestForegroundPermissionsAsync.mockReset();
    location.requestBackgroundPermissionsAsync.mockReset();
    location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    (readBaiduPrivacyConsent as jest.MockedFunction<typeof readBaiduPrivacyConsent>)
      .mockReset()
      .mockResolvedValue(false);
    (
      persistBaiduPrivacyConsent as jest.MockedFunction<typeof persistBaiduPrivacyConsent>
    ).mockReset();
    (baiduSetAgreePrivacy as jest.MockedFunction<typeof baiduSetAgreePrivacy>).mockReset();
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === '同意')?.onPress?.();
    });
  });

  afterEach(() => {
    Platform.OS = originalOs;
    jest.mocked(Alert.alert).mockRestore();
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
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('persists Baidu privacy consent after the user agrees', async () => {
    renderHook(() => useLocationPermissionsOnLaunch());
    await waitFor(() => {
      expect(persistBaiduPrivacyConsent).toHaveBeenCalledWith(true);
      expect(baiduSetAgreePrivacy).toHaveBeenCalledWith(true);
    });
  });

  it('does not prompt again when Baidu privacy consent is already stored', async () => {
    (
      readBaiduPrivacyConsent as jest.MockedFunction<typeof readBaiduPrivacyConsent>
    ).mockResolvedValue(true);
    renderHook(() => useLocationPermissionsOnLaunch());
    await waitFor(() => {
      expect(baiduSetAgreePrivacy).toHaveBeenCalledWith(true);
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(persistBaiduPrivacyConsent).not.toHaveBeenCalled();
  });
});
