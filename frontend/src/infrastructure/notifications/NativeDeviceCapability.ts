import { AppState, Linking, PermissionsAndroid, Platform, type AppStateStatus } from 'react-native';
import * as ExpoLocation from 'expo-location';

import type {
  DeviceCapabilityPort,
  DeviceCapabilityStatus,
  DevicePermission,
} from '../../features/reminder/application/interfaces';
import {
  isTimeflowAlarmAvailable,
  nativeGetAlarmPermissionStatus,
  nativeOpenAlarmPermissionSettings,
  nativeRequestNotificationPermission,
} from './native/TimeflowAlarmBridge';

type LocationModule = typeof import('expo-location');

async function loadExpoLocation(): Promise<LocationModule | null> {
  // Keep this as a static module dependency. The Metro development build
  // reliably bundles expo-location statically, while the previous dynamic
  // import could reject at runtime and make already-granted permissions look
  // denied on the device.
  return ExpoLocation;
}

const SETTINGS_KIND: Partial<
  Record<DevicePermission, 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app'>
> = {
  exact_alarm: 'exactAlarm',
  overlay: 'overlay',
  full_screen: 'fullScreen',
  battery_optimization: 'battery',
  notifications: 'app',
};

/** 基于 TimeflowAlarm + expo-location 的设备权限适配器。 */
export class NativeDeviceCapability implements DeviceCapabilityPort {
  /** 默认走真实的动态 import；测试注入一个假实现，绕开 expo-location 这个原生模块。 */
  constructor(
    private readonly loadLocationModule: () => Promise<LocationModule | null> = loadExpoLocation,
  ) {}

  async getStatus(): Promise<DeviceCapabilityStatus> {
    const platform = toPlatform();
    const location = await this.readLocationPermissions();
    const microphone = await readMicrophonePermission();

    if (!isTimeflowAlarmAvailable()) {
      return {
        platform,
        supported: false,
        permissions: {
          ...emptyPermissions(false),
          location_foreground: location.foreground,
          location_background: location.background,
          microphone,
        },
        background_execution: false,
        oemGuidance: emptyOemGuidance(),
      };
    }

    const status = await nativeGetAlarmPermissionStatus();
    if (status == null) {
      return {
        platform,
        supported: false,
        permissions: {
          ...emptyPermissions(false),
          location_foreground: location.foreground,
          location_background: location.background,
          microphone,
        },
        background_execution: false,
        oemGuidance: emptyOemGuidance(),
      };
    }

    return {
      platform,
      supported: true,
      permissions: {
        notifications: status.notifications,
        exact_alarm: status.exactAlarm,
        overlay: status.overlay,
        full_screen: status.fullScreen,
        battery_optimization: status.battery,
        location_foreground: location.foreground,
        location_background: location.background,
        microphone,
      },
      background_execution: status.battery,
      oemGuidance: {
        manufacturer: status.manufacturer,
        autostartGuided: status.oemAutostartGuided,
        backgroundPopupGuided: status.oemBackgroundPopupGuided,
        lastOverlayFailed: status.oemLastOverlayFailed,
      },
    };
  }

  async requestPermission(permission: DevicePermission): Promise<boolean> {
    if (permission === 'notifications') {
      return nativeRequestNotificationPermission();
    }
    if (permission === 'location_foreground' || permission === 'location_background') {
      return this.requestLocationPermission(permission);
    }
    if (permission === 'microphone') {
      return requestMicrophonePermission();
    }
    return this.openSettings(permission);
  }

  async openSettings(permission: DevicePermission): Promise<boolean> {
    if (permission === 'microphone') {
      // PermissionsAndroid has no read-only "canAskAgain" query like
      // expo-location does, so unlike the location branch below we can't
      // tell ahead of time whether another request() would show a dialog.
      // Keep this a pure settings fallback -- never call request() here --
      // so it can't resurface the system dialog a caller already saw.
      if (await readMicrophonePermission()) {
        return true;
      }
      try {
        await Linking.openSettings();
        return true;
      } catch {
        return false;
      }
    }
    if (permission === 'location_foreground' || permission === 'location_background') {
      try {
        const Location = await this.loadLocationModule();
        if (Location != null) {
          // Read-only: the caller already ran requestPermission() and got a
          // denial. Calling the request API again here would resurface the
          // same system dialog instead of routing to settings. Only fall
          // back to Linking once the system has actually stopped offering
          // its own prompt (canAskAgain === false).
          const response =
            permission === 'location_foreground'
              ? await Location.getForegroundPermissionsAsync()
              : await Location.getBackgroundPermissionsAsync();
          if (response.status === Location.PermissionStatus.GRANTED) {
            return true;
          }
          // Still able to ask again: no settings page to route to yet. Let
          // the caller mark this prompt as skipped for this session instead
          // of re-triggering the system dialog.
          if (response.canAskAgain) {
            return false;
          }
        }

        // Once Android has suppressed the runtime prompt, only the app's detail
        // page can get the user back to Permissions. This is the honest fallback;
        // the foreground/background copy tells the user which row to select.
        await Linking.openSettings();
        return true;
      } catch {
        return false;
      }
    }
    const kind = SETTINGS_KIND[permission] ?? 'app';
    return nativeOpenAlarmPermissionSettings(kind);
  }

  async openOemSettings(kind: 'autostart' | 'backgroundPopup'): Promise<boolean> {
    return nativeOpenAlarmPermissionSettings(kind);
  }

  onAppActive(listener: () => void): () => void {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') listener();
    });
    return () => subscription.remove();
  }

  private async readLocationPermissions(): Promise<{ foreground: boolean; background: boolean }> {
    try {
      const Location = await this.loadLocationModule();
      if (Location == null) return { foreground: false, background: false };
      const foreground = await Location.getForegroundPermissionsAsync();
      const background = await Location.getBackgroundPermissionsAsync();
      return {
        foreground: foreground.status === Location.PermissionStatus.GRANTED,
        background: background.status === Location.PermissionStatus.GRANTED,
      };
    } catch (error) {
      console.warn('[permissions] failed to read location permission status', {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { foreground: false, background: false };
    }
  }

  private async requestLocationPermission(
    permission: 'location_foreground' | 'location_background',
  ): Promise<boolean> {
    try {
      const Location = await this.loadLocationModule();
      if (Location == null) return false;
      if (permission === 'location_foreground') {
        const current = await Location.getForegroundPermissionsAsync();
        if (current.status === Location.PermissionStatus.GRANTED) {
          return true;
        }
        // 系统不再弹授权框时不要空等，交给上层 openSettings。
        if (current.canAskAgain === false) {
          return false;
        }
        const result = await Location.requestForegroundPermissionsAsync();
        return result.status === Location.PermissionStatus.GRANTED;
      }

      const foreground = await Location.getForegroundPermissionsAsync();
      if (foreground.status !== Location.PermissionStatus.GRANTED) {
        if (foreground.canAskAgain === false) {
          return false;
        }
        const requested = await Location.requestForegroundPermissionsAsync();
        if (requested.status !== Location.PermissionStatus.GRANTED) {
          return false;
        }
      }

      const currentBackground = await Location.getBackgroundPermissionsAsync();
      if (currentBackground.status === Location.PermissionStatus.GRANTED) {
        return true;
      }
      if (currentBackground.canAskAgain === false) {
        return false;
      }

      const background = await Location.requestBackgroundPermissionsAsync();
      return background.status === Location.PermissionStatus.GRANTED;
    } catch (error) {
      console.warn('[permissions] failed to request location permission', {
        permission,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }
}

async function readMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  } catch (error) {
    console.warn('[permissions] failed to read microphone permission status', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

async function requestMicrophonePermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (error) {
    console.warn('[permissions] failed to request microphone permission', {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

function toPlatform(): DeviceCapabilityStatus['platform'] {
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'web') return 'web';
  return 'unknown';
}

function emptyOemGuidance(): DeviceCapabilityStatus['oemGuidance'] {
  return {
    manufacturer: null,
    autostartGuided: false,
    backgroundPopupGuided: false,
    lastOverlayFailed: false,
  };
}

function emptyPermissions(value: boolean): Readonly<Record<DevicePermission, boolean>> {
  return {
    notifications: value,
    exact_alarm: value,
    overlay: value,
    full_screen: value,
    battery_optimization: value,
    location_foreground: value,
    location_background: value,
    microphone: value,
  };
}
