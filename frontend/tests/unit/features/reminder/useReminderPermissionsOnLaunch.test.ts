import { act, renderHook } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Alert, AppState, Platform, type AlertButton } from 'react-native';

import type {
  DeviceCapabilityPort,
  DeviceCapabilityStatus,
  DevicePermission,
} from '../../../../src/features/reminder/application/interfaces';
import { useReminderPermissionsOnLaunch } from '../../../../src/features/reminder/presentation/useReminderPermissionsOnLaunch';

function deniedPermissions(): Record<DevicePermission, boolean> {
  return {
    notifications: false,
    exact_alarm: false,
    overlay: false,
    full_screen: false,
    battery_optimization: false,
    location_foreground: false,
    location_background: false,
  };
}

function grantedPermissions(): Record<DevicePermission, boolean> {
  return {
    notifications: true,
    exact_alarm: true,
    overlay: true,
    full_screen: true,
    battery_optimization: true,
    location_foreground: true,
    location_background: true,
  };
}

type FakeDevice = DeviceCapabilityPort & { status: DeviceCapabilityStatus };

function createDevice(
  status: Partial<DeviceCapabilityStatus> & Pick<DeviceCapabilityStatus, 'platform'> = {
    platform: 'android',
  },
): FakeDevice {
  const device: FakeDevice = {
    status: {
      platform: status.platform,
      supported: status.supported ?? status.platform === 'android',
      permissions: { ...deniedPermissions(), ...status.permissions },
      background_execution: status.background_execution ?? true,
    },
    getStatus: jest.fn(async () => device.status),
    requestPermission: jest.fn(async (permission: DevicePermission) => {
      device.status = {
        ...device.status,
        permissions: { ...device.status.permissions, [permission]: true },
      };
      return true;
    }),
    openSettings: jest.fn(async () => true),
  };
  return device;
}

let alertButtons: readonly AlertButton[] = [];
const appStateListeners: ((state: string) => void)[] = [];

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) {
      jest.advanceTimersByTime(ms);
    }
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function press(label: string): Promise<void> {
  await act(async () => {
    alertButtons.find((button) => button.text === label)?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useReminderPermissionsOnLaunch', () => {
  beforeEach(() => {
    alertButtons = [];
    appStateListeners.length = 0;
    Platform.OS = 'android';
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      alertButtons = buttons ?? [];
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      appStateListeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing off Android or without a device', async () => {
    jest.useFakeTimers();
    const androidDevice = createDevice();
    Platform.OS = 'ios';
    renderHook(() => useReminderPermissionsOnLaunch(androidDevice));
    Platform.OS = 'android';
    renderHook(() => useReminderPermissionsOnLaunch(null));
    await flush(1_000);
    expect(androidDevice.getStatus).not.toHaveBeenCalled();
  });

  it('requests notifications directly without an explanation alert', async () => {
    jest.useFakeTimers();
    const device = createDevice({ platform: 'android', supported: true });
    renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(device.requestPermission).toHaveBeenCalledWith('notifications');
  });

  it('asks before opening settings for exact alarm, then resumes on app active', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    expect(Alert.alert).toHaveBeenCalledWith(
      '需要精确闹钟权限',
      expect.any(String),
      expect.any(Array),
    );
    await press('去授权');
    expect(device.openSettings).toHaveBeenCalledWith('exact_alarm');
    expect(device.requestPermission).not.toHaveBeenCalled();

    device.status = {
      ...device.status,
      permissions: { ...device.status.permissions, exact_alarm: true },
    };
    await act(async () => {
      appStateListeners.forEach((listener) => listener('active'));
      await Promise.resolve();
    });
    await flush(300);
    expect(Alert.alert).toHaveBeenCalledWith(
      '需要悬浮窗权限',
      expect.any(String),
      expect.any(Array),
    );
  });

  it('skips a permission when the user declines the explanation alert', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    await press('暂不');
    await flush(250);
    expect(device.openSettings).not.toHaveBeenCalled();
  });

  it('skips and continues when openSettings returns false', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    device.openSettings = jest.fn(async () => false);
    renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    await press('去授权');
    expect(device.openSettings).toHaveBeenCalledWith('exact_alarm');
    await flush(200);
    expect(Alert.alert).toHaveBeenCalledWith(
      '需要悬浮窗权限',
      expect.any(String),
      expect.any(Array),
    );
  });

  it('skips and continues when openSettings throws', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    device.openSettings = jest.fn(async () => {
      throw new Error('settings unavailable');
    });
    renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    await press('去授权');
    await flush(200);
    expect(Alert.alert).toHaveBeenCalledWith(
      '需要悬浮窗权限',
      expect.any(String),
      expect.any(Array),
    );
  });

  it('does not run delayed prompts after unmount', async () => {
    jest.useFakeTimers();
    const device = createDevice();
    const { unmount } = renderHook(() => useReminderPermissionsOnLaunch(device));
    unmount();
    await flush(1_000);
    expect(device.getStatus).not.toHaveBeenCalled();
  });

  it('cancels pending follow-up prompts on unmount', async () => {
    jest.useFakeTimers();
    const device = createDevice();
    const { unmount } = renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    expect(device.getStatus).toHaveBeenCalledTimes(1);
    unmount();
    await flush(1_000);
    expect(device.getStatus).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('does not prompt when every permission is already granted', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: grantedPermissions(),
    });
    renderHook(() => useReminderPermissionsOnLaunch(device));
    await flush(600);
    expect(device.requestPermission).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
