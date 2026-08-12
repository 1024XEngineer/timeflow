import { Platform } from 'react-native';

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

const SETTINGS_KIND: Partial<
  Record<DevicePermission, 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery' | 'app'>
> = {
  exact_alarm: 'exactAlarm',
  overlay: 'overlay',
  full_screen: 'fullScreen',
  battery_optimization: 'battery',
  notifications: 'app',
};

/** 基于 TimeflowAlarm 原生模块的设备权限适配器。 */
export class NativeDeviceCapability implements DeviceCapabilityPort {
  async getStatus(): Promise<DeviceCapabilityStatus> {
    const platform = toPlatform();
    if (!isTimeflowAlarmAvailable()) {
      return {
        platform,
        supported: false,
        permissions: emptyPermissions(false),
        background_execution: false,
      };
    }

    const status = await nativeGetAlarmPermissionStatus();
    if (status == null) {
      return {
        platform,
        supported: false,
        permissions: emptyPermissions(false),
        background_execution: false,
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
        location_foreground: false,
        location_background: false,
      },
      background_execution: status.battery,
    };
  }

  async requestPermission(permission: DevicePermission): Promise<boolean> {
    if (permission === 'notifications') {
      return nativeRequestNotificationPermission();
    }
    return this.openSettings(permission);
  }

  async openSettings(permission: DevicePermission): Promise<boolean> {
    const kind = SETTINGS_KIND[permission] ?? 'app';
    return nativeOpenAlarmPermissionSettings(kind);
  }
}

function toPlatform(): DeviceCapabilityStatus['platform'] {
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'web') return 'web';
  return 'unknown';
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
  };
}
