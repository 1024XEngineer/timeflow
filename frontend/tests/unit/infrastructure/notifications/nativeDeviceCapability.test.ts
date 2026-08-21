import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, Linking, PermissionsAndroid, Platform } from 'react-native';

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

type PermissionResponse = { status: string; canAskAgain: boolean };

const getForeground = jest.fn<() => Promise<PermissionResponse>>();
const requestForeground = jest.fn<() => Promise<PermissionResponse>>();
const getBackground = jest.fn<() => Promise<PermissionResponse>>();
const requestBackground = jest.fn<() => Promise<PermissionResponse>>();

function fakeLocationModule() {
  return {
    getForegroundPermissionsAsync: getForeground,
    requestForegroundPermissionsAsync: requestForeground,
    getBackgroundPermissionsAsync: getBackground,
    requestBackgroundPermissionsAsync: requestBackground,
    PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  } as unknown as typeof import('expo-location');
}

function newDevice(
  loadLocationModule: () => Promise<typeof import('expo-location') | null> = () =>
    Promise.resolve(fakeLocationModule()),
) {
  return new NativeDeviceCapability(loadLocationModule);
}

function granted(): PermissionResponse {
  return { status: 'granted', canAskAgain: true };
}

function denied(canAskAgain = true): PermissionResponse {
  return { status: 'denied', canAskAgain };
}

describe('NativeDeviceCapability', () => {
  beforeEach(() => {
    Platform.OS = 'android';
    available.mockReset().mockReturnValue(true);
    getStatus.mockReset();
    openSettings.mockReset().mockResolvedValue(true);
    requestNotifications.mockReset().mockResolvedValue(true);
    getForeground.mockReset().mockResolvedValue(denied());
    requestForeground.mockReset().mockResolvedValue(denied());
    getBackground.mockReset().mockResolvedValue(denied());
    requestBackground.mockReset().mockResolvedValue(denied());
  });

  it('reports unsupported when the native module is unavailable', async () => {
    available.mockReturnValue(false);
    const device = newDevice();
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
      oemGuidance: {
        manufacturer: null,
        autostartGuided: false,
        backgroundPopupGuided: false,
        lastOverlayFailed: false,
      },
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('reports unsupported when permission status is missing', async () => {
    getStatus.mockResolvedValue(null);
    const device = newDevice();
    await expect(device.getStatus()).resolves.toMatchObject({
      supported: false,
      background_execution: false,
    });
  });

  it('maps native permission flags onto the device port', async () => {
    getStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: false,
      fullScreen: true,
      notifications: true,
      battery: true,
      manufacturer: null,
      oemAutostartGuided: false,
      oemBackgroundPopupGuided: false,
      oemLastOverlayFailed: false,
    });
    const device = newDevice();
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
        microphone: false,
      },
      oemGuidance: {
        manufacturer: null,
        autostartGuided: false,
        backgroundPopupGuided: false,
        lastOverlayFailed: false,
      },
    });
  });

  it.each<[typeof Platform.OS, string]>([
    ['ios', 'ios'],
    ['web', 'web'],
    ['windows', 'unknown'],
  ])('maps Platform.OS %s to platform %s', async (os, platform) => {
    Platform.OS = os;
    available.mockReturnValue(false);
    const device = newDevice();
    await expect(device.getStatus()).resolves.toMatchObject({ platform });
  });

  it('reports location foreground/background permissions read from expo-location', async () => {
    getForeground.mockResolvedValue(granted());
    getBackground.mockResolvedValue(granted());
    getStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: true,
      fullScreen: true,
      notifications: true,
      battery: true,
      manufacturer: null,
      oemAutostartGuided: false,
      oemBackgroundPopupGuided: false,
      oemLastOverlayFailed: false,
    });
    const device = newDevice();
    await expect(device.getStatus()).resolves.toMatchObject({
      permissions: {
        location_foreground: true,
        location_background: true,
      },
    });
  });

  it('reports location permissions as false when the expo-location read throws', async () => {
    getForeground.mockRejectedValue(new Error('location module unavailable'));
    getStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: true,
      fullScreen: true,
      notifications: true,
      battery: true,
      manufacturer: null,
      oemAutostartGuided: false,
      oemBackgroundPopupGuided: false,
      oemLastOverlayFailed: false,
    });
    const device = newDevice();
    await expect(device.getStatus()).resolves.toMatchObject({
      permissions: {
        location_foreground: false,
        location_background: false,
      },
    });
  });

  it('reports location permissions as false when the location module fails to load', async () => {
    const device = newDevice(() => Promise.resolve(null));
    getStatus.mockResolvedValue({
      exactAlarm: true,
      overlay: true,
      fullScreen: true,
      notifications: true,
      battery: true,
      manufacturer: null,
      oemAutostartGuided: false,
      oemBackgroundPopupGuided: false,
      oemLastOverlayFailed: false,
    });
    await expect(device.getStatus()).resolves.toMatchObject({
      permissions: {
        location_foreground: false,
        location_background: false,
      },
    });
    expect(getForeground).not.toHaveBeenCalled();
  });

  it('requestPermission for location fails when the location module fails to load', async () => {
    const device = newDevice(() => Promise.resolve(null));
    await expect(device.requestPermission('location_foreground')).resolves.toBe(false);
    expect(getForeground).not.toHaveBeenCalled();
  });

  it('requests notification permission through the native prompt', async () => {
    const device = newDevice();
    await expect(device.requestPermission('notifications')).resolves.toBe(true);
    expect(requestNotifications).toHaveBeenCalledTimes(1);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('opens the matching settings page for non-notification, non-location permissions', async () => {
    const device = newDevice();
    await expect(device.requestPermission('exact_alarm')).resolves.toBe(true);
    await expect(device.openSettings('overlay')).resolves.toBe(true);
    await expect(device.openSettings('full_screen')).resolves.toBe(true);
    await expect(device.openSettings('battery_optimization')).resolves.toBe(true);
    expect(openSettings.mock.calls.map((call) => call[0])).toEqual([
      'exactAlarm',
      'overlay',
      'fullScreen',
      'battery',
    ]);
  });

  it('falls back to the real expo-location module when no loader is injected', async () => {
    // Exercises the default constructor arg (loadExpoLocation), which the rest of
    // this suite bypasses by always injecting a fake loader. Without a native
    // module present, expo-location's read throws and the call fails closed.
    const device = new NativeDeviceCapability();
    await expect(device.openSettings('location_foreground')).resolves.toBe(false);
  });

  describe('location permission requests', () => {
    it('requestPermission(location_foreground) grants immediately when already granted', async () => {
      getForeground.mockResolvedValue(granted());
      const device = newDevice();
      await expect(device.requestPermission('location_foreground')).resolves.toBe(true);
      expect(requestForeground).not.toHaveBeenCalled();
    });

    it('requestPermission(location_foreground) prompts when not yet granted and can still ask', async () => {
      getForeground.mockResolvedValue(denied(true));
      requestForeground.mockResolvedValue(granted());
      const device = newDevice();
      await expect(device.requestPermission('location_foreground')).resolves.toBe(true);
      expect(requestForeground).toHaveBeenCalledTimes(1);
    });

    it('requestPermission(location_foreground) fails closed without prompting when the system will not ask again', async () => {
      getForeground.mockResolvedValue(denied(false));
      const device = newDevice();
      await expect(device.requestPermission('location_foreground')).resolves.toBe(false);
      expect(requestForeground).not.toHaveBeenCalled();
    });

    it('requestPermission(location_background) escalates through foreground then background', async () => {
      getForeground.mockResolvedValue(granted());
      getBackground.mockResolvedValue(denied(true));
      requestBackground.mockResolvedValue(granted());
      const device = newDevice();
      await expect(device.requestPermission('location_background')).resolves.toBe(true);
      expect(requestForeground).not.toHaveBeenCalled();
      expect(requestBackground).toHaveBeenCalledTimes(1);
    });

    it('requestPermission(location_background) requests foreground first when missing', async () => {
      getForeground.mockResolvedValue(denied(true));
      requestForeground.mockResolvedValue(granted());
      getBackground.mockResolvedValue(granted());
      const device = newDevice();
      await expect(device.requestPermission('location_background')).resolves.toBe(true);
      expect(requestForeground).toHaveBeenCalledTimes(1);
    });

    it('requestPermission(location_background) fails when foreground cannot be granted', async () => {
      getForeground.mockResolvedValue(denied(false));
      const device = newDevice();
      await expect(device.requestPermission('location_background')).resolves.toBe(false);
      expect(requestBackground).not.toHaveBeenCalled();
    });

    it('requestPermission(location_background) fails when the foreground prompt is declined', async () => {
      getForeground.mockResolvedValue(denied(true));
      requestForeground.mockResolvedValue(denied());
      const device = newDevice();
      await expect(device.requestPermission('location_background')).resolves.toBe(false);
      expect(requestBackground).not.toHaveBeenCalled();
    });

    it('requestPermission(location_background) already-granted background short-circuits', async () => {
      getForeground.mockResolvedValue(granted());
      getBackground.mockResolvedValue(granted());
      const device = newDevice();
      await expect(device.requestPermission('location_background')).resolves.toBe(true);
      expect(requestBackground).not.toHaveBeenCalled();
    });

    it('requestPermission(location_background) fails closed when background cannot ask again', async () => {
      getForeground.mockResolvedValue(granted());
      getBackground.mockResolvedValue(denied(false));
      const device = newDevice();
      await expect(device.requestPermission('location_background')).resolves.toBe(false);
      expect(requestBackground).not.toHaveBeenCalled();
    });

    it('requestPermission for location fails closed when the expo-location module throws', async () => {
      getForeground.mockRejectedValue(new Error('module unavailable'));
      const device = newDevice();
      await expect(device.requestPermission('location_foreground')).resolves.toBe(false);
    });
  });

  describe('openSettings for location permissions', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reads current status instead of re-requesting when already granted', async () => {
      const openLinkingSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      getForeground.mockResolvedValue(granted());
      getBackground.mockResolvedValue(granted());
      const device = newDevice();
      await expect(device.openSettings('location_foreground')).resolves.toBe(true);
      await expect(device.openSettings('location_background')).resolves.toBe(true);
      expect(requestForeground).not.toHaveBeenCalled();
      expect(requestBackground).not.toHaveBeenCalled();
      expect(openLinkingSettings).not.toHaveBeenCalled();
      expect(openSettings).not.toHaveBeenCalled();
    });

    it('fails closed without re-prompting when the system can still ask again', async () => {
      const openLinkingSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      getForeground.mockResolvedValue(denied(true));
      const device = newDevice();
      await expect(device.openSettings('location_foreground')).resolves.toBe(false);
      expect(requestForeground).not.toHaveBeenCalled();
      expect(openLinkingSettings).not.toHaveBeenCalled();
    });

    it('falls back to app settings when the system no longer offers a location prompt', async () => {
      const openLinkingSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      getForeground.mockResolvedValue(denied(false));
      const device = newDevice();
      await expect(device.openSettings('location_foreground')).resolves.toBe(true);
      expect(requestForeground).not.toHaveBeenCalled();
      expect(openLinkingSettings).toHaveBeenCalledTimes(1);
    });

    it('returns false when the location settings fallback cannot open', async () => {
      jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('cannot open settings'));
      getForeground.mockResolvedValue(denied(false));
      const device = newDevice();
      await expect(device.openSettings('location_foreground')).resolves.toBe(false);
    });
  });

  describe('microphone permission', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('getStatus reports the microphone flag read from PermissionsAndroid.check', async () => {
      jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
      getStatus.mockResolvedValue({
        exactAlarm: true,
        overlay: true,
        fullScreen: true,
        notifications: true,
        battery: true,
        manufacturer: null,
        oemAutostartGuided: false,
        oemBackgroundPopupGuided: false,
        oemLastOverlayFailed: false,
      });
      const device = newDevice();
      await expect(device.getStatus()).resolves.toMatchObject({
        permissions: { microphone: true },
      });
    });

    it('getStatus fails closed when PermissionsAndroid.check throws', async () => {
      jest.spyOn(PermissionsAndroid, 'check').mockRejectedValue(new Error('boom'));
      getStatus.mockResolvedValue({
        exactAlarm: true,
        overlay: true,
        fullScreen: true,
        notifications: true,
        battery: true,
        manufacturer: null,
        oemAutostartGuided: false,
        oemBackgroundPopupGuided: false,
        oemLastOverlayFailed: false,
      });
      const device = newDevice();
      await expect(device.getStatus()).resolves.toMatchObject({
        permissions: { microphone: false },
      });
    });

    it('requestPermission(microphone) returns true when granted', async () => {
      const request = jest
        .spyOn(PermissionsAndroid, 'request')
        .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
      const device = newDevice();
      await expect(device.requestPermission('microphone')).resolves.toBe(true);
      expect(request).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    });

    it.each([PermissionsAndroid.RESULTS.DENIED, PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN])(
      'requestPermission(microphone) returns false for result %s',
      async (result) => {
        jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(result);
        const device = newDevice();
        await expect(device.requestPermission('microphone')).resolves.toBe(false);
      },
    );

    it('requestPermission(microphone) fails closed when PermissionsAndroid.request throws', async () => {
      jest.spyOn(PermissionsAndroid, 'request').mockRejectedValue(new Error('boom'));
      const device = newDevice();
      await expect(device.requestPermission('microphone')).resolves.toBe(false);
    });

    it('requestPermission(microphone) is false on non-android platforms without calling PermissionsAndroid', async () => {
      Platform.OS = 'ios';
      const request = jest.spyOn(PermissionsAndroid, 'request');
      const device = newDevice();
      await expect(device.requestPermission('microphone')).resolves.toBe(false);
      expect(request).not.toHaveBeenCalled();
    });

    it('openSettings(microphone) returns true immediately when already granted, without touching Settings', async () => {
      jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
      const request = jest.spyOn(PermissionsAndroid, 'request');
      // Linking.openSettings' jest spy doesn't reset call history across tests in
      // this environment (see the "falls back to app settings" tests above, which
      // never assert 0 after a prior call) -- clear explicitly so this assertion
      // reflects only this test's behavior.
      const openLinkingSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      openLinkingSettings.mockClear();
      const device = newDevice();
      await expect(device.openSettings('microphone')).resolves.toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(openLinkingSettings).not.toHaveBeenCalled();
    });

    it('openSettings(microphone) falls back to Linking.openSettings without re-requesting', async () => {
      jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
      const request = jest.spyOn(PermissionsAndroid, 'request');
      const openLinkingSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      openLinkingSettings.mockClear();
      const device = newDevice();
      await expect(device.openSettings('microphone')).resolves.toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(openLinkingSettings).toHaveBeenCalledTimes(1);
    });

    it('openSettings(microphone) returns false when the Settings fallback cannot open', async () => {
      jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
      jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('cannot open settings'));
      const device = newDevice();
      await expect(device.openSettings('microphone')).resolves.toBe(false);
    });
  });

  describe('oemGuidance', () => {
    it('maps manufacturer and guidance flags from the native status', async () => {
      getStatus.mockResolvedValue({
        exactAlarm: true,
        overlay: true,
        fullScreen: true,
        notifications: true,
        battery: true,
        manufacturer: 'xiaomi',
        oemAutostartGuided: true,
        oemBackgroundPopupGuided: false,
        oemLastOverlayFailed: true,
      });
      const device = newDevice();

      await expect(device.getStatus()).resolves.toMatchObject({
        oemGuidance: {
          manufacturer: 'xiaomi',
          autostartGuided: true,
          backgroundPopupGuided: false,
          lastOverlayFailed: true,
        },
      });
    });

    it('openOemSettings forwards the kind to the native module', async () => {
      const device = newDevice();
      await expect(device.openOemSettings('autostart')).resolves.toBe(true);
      expect(openSettings).toHaveBeenCalledWith('autostart');

      await expect(device.openOemSettings('backgroundPopup')).resolves.toBe(true);
      expect(openSettings).toHaveBeenCalledWith('backgroundPopup');
    });
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

      const device = newDevice();
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

      const device = newDevice();
      const unsubscribe = device.onAppActive(jest.fn());

      expect(remove).not.toHaveBeenCalled();
      unsubscribe();
      expect(remove).toHaveBeenCalledTimes(1);
    });
  });
});
