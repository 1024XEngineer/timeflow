import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules } from 'react-native';

import { getNativeLastKnownLocationSample } from '../../../../src/infrastructure/location/NativeLocationFallback';

const mockNativeGetLastKnownLocation = jest.fn<() => Promise<unknown>>();

describe('getNativeLastKnownLocationSample', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (NativeModules as unknown as { TimeflowLocation?: unknown }).TimeflowLocation = {
      getLastKnownLocation: mockNativeGetLastKnownLocation,
    };
  });

  it('maps the native Android last-known location into a LocationObservation', async () => {
    mockNativeGetLastKnownLocation.mockResolvedValue({
      accuracyMeters: 30,
      latitude: 31.187169,
      longitude: 121.605098,
      observedAtMillis: Date.parse('2026-08-20T09:37:26.000Z'),
      provider: 'network',
    });

    await expect(getNativeLastKnownLocationSample()).resolves.toEqual({
      accuracy_meters: 30,
      latitude: 31.187169,
      longitude: 121.605098,
      observed_at: '2026-08-20T09:37:26.000Z',
    });
  });

  it('returns null when the native module reports no cached location', async () => {
    mockNativeGetLastKnownLocation.mockResolvedValue(null);
    await expect(getNativeLastKnownLocationSample()).resolves.toBeNull();
  });

  it('returns null when the native module is unavailable', async () => {
    delete (NativeModules as unknown as { TimeflowLocation?: unknown }).TimeflowLocation;

    await expect(getNativeLastKnownLocationSample()).resolves.toBeNull();
  });

  it('returns null when the native module rejects the location read', async () => {
    mockNativeGetLastKnownLocation.mockRejectedValue(new Error('native location unavailable'));

    await expect(getNativeLastKnownLocationSample()).resolves.toBeNull();
  });

  it('returns null when the native payload is malformed', async () => {
    mockNativeGetLastKnownLocation.mockResolvedValue({
      accuracyMeters: 30,
      latitude: 91,
      longitude: 121.605098,
      observedAtMillis: Date.parse('2026-08-20T09:37:26.000Z'),
    });

    await expect(getNativeLastKnownLocationSample()).resolves.toBeNull();
  });
});
