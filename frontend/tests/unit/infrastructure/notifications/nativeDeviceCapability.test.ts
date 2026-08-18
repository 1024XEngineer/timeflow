import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, Platform } from 'react-native';

import { NativeDeviceCapability } from '../../../../src/infrastructure/notifications/NativeDeviceCapability';
import {
  isTimeflowAlarmAvailable,
  nativeGetAlarmPermissionStatus,
  nativeOpenAlarmPermissionSettings,
  nativeRequestNotificationPermission,
} from '../../../../src/infrastructure/notifications/native/TimeflowAlarmBridge';

jest.mock('../../../../src/infrastructure/notifications/native/TimeflowAlarmBridge', () => ({
  isTimeflowAlarmAvailable: jest.fn(),
  nativeGetAlarmPermissionStatus: jest.fn(),
  nativeOpenAlarmPermissionSettings: jest.fn(),
  nativeRequestNotificationPermission: jest.fn(),
}));

const available = isTimeflowAlarmAvailable as jest.MockedFunction<typeof isTimeflowAlarmAvailable>;
const getStatus = nativeGetAlarmPermissionStatus as jest.MockedFunction<
  typeof nativeGetAlarmPermissionStatus
>;
const openSettings = nativeOpenAlarmPermissionSettings as jest.MockedFunction<
  typeof nativeOpenAlarmPermissionSettings
>;
const requestNotifications = nativeRequestNotificationPermission as jest.MockedFunction<
  typeof nativeRequestNotificationPermission
>;

describe('NativeDeviceCapability', () => {
  beforeEach(() => {
    Platform.OS = 'android';
    available.mockReset().mockReturnValue(true);
    getStatus.mockReset();
    openSettings.mockReset().mockResolvedValue(true);
    requestNotifications.mockReset().mockResolvedValue(true);
  });

  it('reports unsupported when the native module is unavailable', async () => {
    available.mockReturnValue(false);
    const device = new NativeDeviceCapability();
    await expect(device.getStatus()).resolves.toMatchObject({
      platform: 'android',
      supported: false,
      background_execution: false,
      permissions: {
        notifications: false,
        exact_alarm: false,
        overlay: false,
        full_screen: false,
        battery_optimization: false,
        location_foreground: false,
        location_background: false,
      },
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('reports unsupported when permission status is missing', async () => {
    getStatus.mockResolvedValue(null);
    const device = new NativeDeviceCapability();
    await expect(device.getStatus()).resolves.toMatchObject({
      supported: false,
      background_execution: false,
    });
  });

  it('reports unsupported when the native status read rejects', async () => {
    getStatus.mockRejectedValue(new Error('bridge unavailable'));
    const device = new NativeDeviceCapability();
    await expect(device.getStatus()).resolves.toMatchObject({
      platform: 'android',
      supported: false,
      background_execution: false,
      permissions: {
        notifications: false,
        exact_alarm: false,
        overlay: false,
        full_screen: false,
        battery_optimization: false,
        location_foreground: false,
        location_background: false,
      },
    });
  });

  it('maps native permission flags onto the device port', async () => {
    getStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: false,
      fullScreen: true,
      notifications: true,
      battery: true,
    });
    const device = new NativeDeviceCapability();
    await expect(device.getStatus()).resolves.toEqual({
      platform: 'android',
      supported: true,
      background_execution: true,
      permissions: {
        notifications: true,
        exact_alarm: true,
        overlay: false,
        full_screen: true,
        battery_optimization: true,
        location_foreground: false,
        location_background: false,
      },
    });
  });

  it('requests notification permission through the native prompt', async () => {
    const device = new NativeDeviceCapability();
    await expect(device.requestPermission('notifications')).resolves.toBe(true);
    expect(requestNotifications).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('returns false when the native notification permission request rejects', async () => {
    requestNotifications.mockRejectedValue(new Error('prompt failed'));
    const device = new NativeDeviceCapability();
    await expect(device.requestPermission('notifications')).resolves.toBe(false);
  });

  it('returns false when opening settings rejects', async () => {
    openSettings.mockRejectedValue(new Error('intent failed'));
    const device = new NativeDeviceCapability();
    await expect(device.openSettings('overlay')).resolves.toBe(false);
    await expect(device.requestPermission('exact_alarm')).resolves.toBe(false);
  });

  it('opens the matching settings page for non-notification permissions', async () => {
    const device = new NativeDeviceCapability();
    await expect(device.requestPermission('exact_alarm')).resolves.toBe(true);
    await expect(device.openSettings('overlay')).resolves.toBe(true);
    await expect(device.openSettings('full_screen')).resolves.toBe(true);
    await expect(device.openSettings('battery_optimization')).resolves.toBe(true);
    await expect(device.openSettings('location_foreground')).resolves.toBe(true);
    expect(openSettings.mock.calls.map((call) => call[0])).toEqual([
      'exactAlarm',
      'overlay',
      'fullScreen',
      'battery',
      'app',
    ]);
  });

  describe('onAppActive', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('calls the listener only when AppState transitions to active', () => {
      const remove = jest.fn();
      const addEventListener = jest
        .spyOn(AppState, 'addEventListener')
        .mockReturnValue({ remove } as unknown as ReturnType<typeof AppState.addEventListener>);

      const device = new NativeDeviceCapability();
      const listener = jest.fn();
      device.onAppActive(listener);

      expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
      const handler = addEventListener.mock.calls[0][1] as (state: string) => void;

      handler('background');
      expect(listener).not.toHaveBeenCalled();

      handler('active');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('removes the underlying subscription when the returned unsubscribe is called', () => {
      const remove = jest.fn();
      jest
        .spyOn(AppState, 'addEventListener')
        .mockReturnValue({ remove } as unknown as ReturnType<typeof AppState.addEventListener>);

      const device = new NativeDeviceCapability();
      const unsubscribe = device.onAppActive(jest.fn());

      expect(remove).not.toHaveBeenCalled();
      unsubscribe();
      expect(remove).toHaveBeenCalledTimes(1);
    });
  });
});
