import { act, renderHook } from '@testing-library/react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

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

type FakeDevice = DeviceCapabilityPort & {
  status: DeviceCapabilityStatus;
  emitActive: () => void;
};

function createDevice(
  status: Partial<DeviceCapabilityStatus> & Pick<DeviceCapabilityStatus, 'platform'> = {
    platform: 'android',
  },
): FakeDevice {
  const appActive = new Set<() => void>();
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
    onAppActive: jest.fn((listener: () => void) => {
      appActive.add(listener);
      return () => {
        appActive.delete(listener);
      };
    }),
    emitActive() {
      for (const listener of appActive) {
        listener();
      }
    },
  };
  return device;
}

function createDialog(): AlertDialogPort & { requests: AlertDialogRequest[] } {
  const dialog = {
    requests: [] as AlertDialogRequest[],
    show: jest.fn(async (request: AlertDialogRequest) => {
      dialog.requests.push(request);
    }),
  };
  return dialog;
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

async function press(label: string, requests: AlertDialogRequest[]): Promise<void> {
  await act(async () => {
    requests[requests.length - 1]?.buttons.find((button) => button.text === label)?.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useReminderPermissionsOnLaunch', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllTimers();
  });

  it('does nothing when the device or dialog is missing', async () => {
    jest.useFakeTimers();
    const device = createDevice();
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(null, dialog));
    renderHook(() => useReminderPermissionsOnLaunch(device, null));
    await flush(1_000);
    expect(device.getStatus).not.toHaveBeenCalled();
  });

  it('skips permission prompts on web and unknown platforms', async () => {
    jest.useFakeTimers();
    const web = createDevice({ platform: 'web' });
    const unknown = createDevice({ platform: 'unknown' });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(web, dialog));
    renderHook(() => useReminderPermissionsOnLaunch(unknown, dialog));
    await flush(600);
    expect(web.requestPermission).not.toHaveBeenCalled();
    expect(unknown.requestPermission).not.toHaveBeenCalled();
    expect(dialog.show).not.toHaveBeenCalled();
  });

  it('requests notifications directly on Android without a pre-prompt', async () => {
    jest.useFakeTimers();
    const device = createDevice({ platform: 'android', supported: true });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog));
    await flush(600);
    expect(dialog.show).not.toHaveBeenCalled();
    expect(device.requestPermission).toHaveBeenCalledWith('notifications');
  });

  it('asks before opening settings for exact alarm, then resumes on app active', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog));

    await flush(600);
    expect(dialog.requests[0]?.title).toBe('需要精确闹钟权限');
    await press('去授权', dialog.requests);
    expect(device.openSettings).toHaveBeenCalledWith('exact_alarm');
    expect(device.requestPermission).not.toHaveBeenCalled();

    device.status = {
      ...device.status,
      permissions: { ...device.status.permissions, exact_alarm: true },
    };
    await act(async () => {
      device.emitActive();
      await Promise.resolve();
    });
    await flush(300);
    expect(dialog.requests.some((item) => item.title === '需要悬浮窗权限')).toBe(true);
  });

  it('skips a permission when the user declines the explanation dialog', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: { ...deniedPermissions(), notifications: true },
    });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog));

    await flush(600);
    await press('暂不', dialog.requests);
    await flush(250);
    expect(device.openSettings).not.toHaveBeenCalled();
    expect(dialog.requests.filter((item) => item.title === '需要精确闹钟权限')).toHaveLength(1);
  });

  it('does not prompt when every permission is already granted', async () => {
    jest.useFakeTimers();
    const device = createDevice({
      platform: 'android',
      supported: true,
      permissions: grantedPermissions(),
    });
    const dialog = createDialog();
    renderHook(() => useReminderPermissionsOnLaunch(device, dialog));
    await flush(600);
    expect(device.requestPermission).not.toHaveBeenCalled();
    expect(dialog.show).not.toHaveBeenCalled();
  });

  it('unsubscribes from app-active on unmount', async () => {
    jest.useFakeTimers();
    const device = createDevice();
    const dialog = createDialog();
    const { unmount } = renderHook(() => useReminderPermissionsOnLaunch(device, dialog));
    expect(device.onAppActive).toHaveBeenCalledTimes(1);
    unmount();
    await flush(600);
    expect(device.getStatus).not.toHaveBeenCalled();
  });
});
