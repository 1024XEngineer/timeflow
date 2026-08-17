import { act, renderHook } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  AlertDialogPort,
  AlertDialogRequest,
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
  status: Partial<DeviceCapabilityStatus> & Pick<DeviceCapabilityStatus, 'platform'>,
): FakeDevice {
  const listeners: (() => void)[] = [];
  const device: FakeDevice = {
    status: {
      platform: status.platform,
      supported: status.supported ?? status.platform === 'android',
      permissions: { ...grantedPermissions(), ...status.permissions },
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
    onAppActive: jest.fn((listener: () => void) => {
      listeners.push(listener);
      return jest.fn();
    }),
  };
  (device as unknown as { fireAppActive: () => void }).fireAppActive = () => {
    listeners.forEach((listener) => listener());
  };
  return device;
}

let dialogRequest: AlertDialogRequest | undefined;

function createDialog(): AlertDialogPort {
  return {
    show: jest.fn(async (request: AlertDialogRequest) => {
      dialogRequest = request;
    }),
  };
}

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
    dialogRequest?.buttons.find((button) => button.text === label)?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useReminderPermissionsOnLaunch', () => {
  beforeEach(() => {
    dialogRequest = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing without a device or a dialog', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: deniedPermissions(),
    });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(null, dialog));
    renderHook(() => useReminderPermissionsOnLaunch(device, null));
    await flush(1_000);
    expect(device.getStatus).not.toHaveBeenCalled();
    expect(dialog.show).not.toHaveBeenCalled();
  });

  it('requests notifications directly without a dialog, then reports the update', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: deniedPermissions(),
    });
    const dialog = createDialog();
    const onPermissionsUpdated = jest.fn();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog, onPermissionsUpdated));
    await flush(600);
    expect(dialog.show).not.toHaveBeenCalled();
    expect(device.requestPermission).toHaveBeenCalledWith('notifications');
    expect(onPermissionsUpdated).toHaveBeenCalledTimes(1);
  });

  it('jumps straight to settings for exact alarm, then resumes once the app is active again', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    const dialog = createDialog();
    const onPermissionsUpdated = jest.fn();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog, onPermissionsUpdated));
    await flush(600);
    expect(dialog.show).not.toHaveBeenCalled();
    expect(device.openSettings).toHaveBeenCalledWith('exact_alarm');
    expect(device.requestPermission).not.toHaveBeenCalledWith('exact_alarm');

    device.status = {
      ...device.status,
      permissions: { ...device.status.permissions, exact_alarm: true },
    };
    await act(async () => {
      (device as unknown as { fireAppActive: () => void }).fireAppActive();
      await Promise.resolve();
    });
    await flush(300);
    expect(onPermissionsUpdated).toHaveBeenCalledTimes(1);
    expect(dialog.show).toHaveBeenCalledWith(expect.objectContaining({ title: '需要悬浮窗权限' }));
  });

  it('shows a dialog before requesting location permission, and falls back to settings when denied', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), location_foreground: false },
      background_execution: true,
    });
    device.status.permissions = {
      ...grantedPermissions(),
      location_foreground: false,
    };
    device.requestPermission = jest.fn(async () => false);
    const dialog = createDialog();
    const onPermissionsUpdated = jest.fn();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog, onPermissionsUpdated));
    await flush(600);
    expect(dialog.show).toHaveBeenCalledWith(expect.objectContaining({ title: '需要定位权限' }));

    await press('去授权');
    await flush(350);
    expect(device.requestPermission).toHaveBeenCalledWith('location_foreground');
    expect(device.openSettings).toHaveBeenCalledWith('location_foreground');
    expect(onPermissionsUpdated).not.toHaveBeenCalled();
  });

  it('skips a permission and moves on when the user declines the dialog', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...grantedPermissions(), overlay: false, full_screen: false },
    });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog));
    await flush(600);
    expect(dialog.show).toHaveBeenCalledWith(expect.objectContaining({ title: '需要悬浮窗权限' }));

    await press('暂不');
    await flush(250);
    expect(device.openSettings).not.toHaveBeenCalledWith('overlay');
    expect(dialog.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: '需要全屏通知权限' }),
    );
  });
});
