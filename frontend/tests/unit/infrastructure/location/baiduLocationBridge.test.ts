import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NativeModules, Platform } from 'react-native';

import {
  baiduGetCurrentPosition,
  baiduInit,
  baiduSetAgreePrivacy,
  baiduStartUpdating,
  baiduStopUpdating,
  isBaiduLocationAvailable,
  persistBaiduPrivacyConsent,
  readBaiduPrivacyConsent,
  subscribeBaiduLocation,
} from '../../../../src/infrastructure/location/native/BaiduLocationBridge';

type BaiduNativeMock = {
  setAgreePrivacy: jest.MockedFunction<(agree: boolean) => Promise<boolean>>;
  getPrivacyConsent: jest.MockedFunction<() => Promise<boolean>>;
  persistPrivacyConsent: jest.MockedFunction<(agree: boolean) => Promise<boolean>>;
  init: jest.MockedFunction<(ak: string | null) => Promise<boolean>>;
  startUpdating: jest.MockedFunction<(intervalMs: number) => Promise<boolean>>;
  stopUpdating: jest.MockedFunction<() => Promise<boolean>>;
  getCurrentPosition: jest.MockedFunction<
    () => Promise<{
      latitude: number;
      longitude: number;
      accuracy: number;
      observedAt: string;
    } | null>
  >;
  addListener: jest.MockedFunction<(eventName: string) => void>;
  removeListeners: jest.MockedFunction<(count: number) => void>;
};

function installBaiduNative(): BaiduNativeMock {
  const native: BaiduNativeMock = {
    setAgreePrivacy: jest.fn(async () => true),
    getPrivacyConsent: jest.fn(async () => false),
    persistPrivacyConsent: jest.fn(async (agree: boolean) => {
      native.getPrivacyConsent.mockResolvedValue(agree);
      return true;
    }),
    init: jest.fn(async () => true),
    startUpdating: jest.fn(async () => true),
    stopUpdating: jest.fn(async () => true),
    getCurrentPosition: jest.fn(async () => ({
      latitude: 31.23,
      longitude: 121.47,
      accuracy: 12,
      observedAt: '2026-08-13T08:00:00.000Z',
    })),
    addListener: jest.fn(() => undefined),
    removeListeners: jest.fn(() => undefined),
  };
  NativeModules.TimeflowBaiduLocation = native;
  return native;
}

describe('BaiduLocationBridge', () => {
  let native: BaiduNativeMock;
  const originalOs = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'android';
    native = installBaiduNative();
  });

  afterEach(() => {
    Platform.OS = originalOs;
    delete NativeModules.TimeflowBaiduLocation;
  });

  it('is only available on Android when the native module exists', () => {
    expect(isBaiduLocationAvailable()).toBe(true);
    Platform.OS = 'ios';
    expect(isBaiduLocationAvailable()).toBe(false);
  });

  it('does not init or start updates until privacy consent is persisted', async () => {
    await expect(baiduInit('ak-test')).resolves.toBe(false);
    await expect(baiduStartUpdating(3_000)).resolves.toBe(false);
    expect(native.setAgreePrivacy).not.toHaveBeenCalled();
    expect(native.init).not.toHaveBeenCalled();
    expect(native.startUpdating).not.toHaveBeenCalled();
  });

  it('agrees privacy, inits, and starts updates after consent is stored', async () => {
    await persistBaiduPrivacyConsent(true);
    await baiduSetAgreePrivacy(true);
    await expect(baiduInit('ak-test')).resolves.toBe(true);
    await expect(baiduStartUpdating(3_000)).resolves.toBe(true);
    expect(native.persistPrivacyConsent).toHaveBeenCalledWith(true);
    expect(native.setAgreePrivacy).toHaveBeenCalledWith(true);
    expect(native.init).toHaveBeenCalledWith('ak-test');
    expect(native.startUpdating).toHaveBeenCalledWith(3_000);
  });

  it('reads stored privacy consent', async () => {
    native.getPrivacyConsent.mockResolvedValueOnce(true);
    await expect(readBaiduPrivacyConsent()).resolves.toBe(true);
    native.getPrivacyConsent.mockResolvedValueOnce(false);
    await expect(readBaiduPrivacyConsent()).resolves.toBe(false);
  });

  it('reads the current position from the native module', async () => {
    await expect(baiduGetCurrentPosition()).resolves.toMatchObject({
      latitude: 31.23,
      longitude: 121.47,
    });
    await baiduStopUpdating();
    expect(native.stopUpdating).toHaveBeenCalledTimes(1);
  });

  it('returns false or null when the native module is missing', async () => {
    delete NativeModules.TimeflowBaiduLocation;
    await expect(baiduInit('ak-test')).resolves.toBe(false);
    await expect(baiduStartUpdating()).resolves.toBe(false);
    await expect(baiduGetCurrentPosition()).resolves.toBeNull();
  });

  it('subscribe returns an unsubscribe function', () => {
    const unsubscribe = subscribeBaiduLocation(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
