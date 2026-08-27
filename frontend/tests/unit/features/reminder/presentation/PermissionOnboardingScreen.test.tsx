import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type {
  DeviceCapabilityPort,
  DeviceCapabilityStatus,
  DevicePermission,
} from '../../../../../src/features/reminder/application/interfaces';
import { PermissionOnboardingScreen } from '../../../../../src/features/reminder/presentation/PermissionOnboardingScreen';

let mockBottomInset = 0;
let mockTopInset = 0;

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockBottomInset, left: 0, right: 0, top: mockTopInset }),
}));

function grantedPermissions(): Record<DevicePermission, boolean> {
  return {
    notifications: true,
    exact_alarm: true,
    overlay: true,
    full_screen: true,
    battery_optimization: true,
    location_foreground: true,
    location_background: true,
    microphone: true,
  };
}

function deniedPermissions(): Record<DevicePermission, boolean> {
  return {
    notifications: false,
    exact_alarm: false,
    overlay: false,
    full_screen: false,
    battery_optimization: false,
    location_foreground: false,
    location_background: false,
    microphone: false,
  };
}

type FakeDevice = DeviceCapabilityPort & {
  status: DeviceCapabilityStatus;
  fireAppActive: () => void;
};

function createDevice(permissions: Record<DevicePermission, boolean>): FakeDevice {
  const listeners: (() => void)[] = [];
  const device = {
    status: {
      platform: 'android' as const,
      supported: true,
      permissions,
      background_execution: true,
      oemGuidance: {
        manufacturer: null,
        autostartGuided: false,
        backgroundPopupGuided: false,
        lastOverlayFailed: false,
      },
    },
    getStatus: jest.fn(async () => device.status),
    requestPermission: jest.fn(async (permission: DevicePermission) => {
      device.status = {
        ...device.status,
        permissions: { ...device.status.permissions, [permission]: true },
      };
      return true;
    }),
    openOemSettings: jest.fn(async (kind: 'autostart' | 'backgroundPopup') => {
      device.status = {
        ...device.status,
        oemGuidance: {
          ...device.status.oemGuidance,
          [kind === 'autostart' ? 'autostartGuided' : 'backgroundPopupGuided']: true,
        },
      };
      return true;
    }),
    openSettings: jest.fn(async () => true),
    onAppActive: jest.fn((listener: () => void) => {
      listeners.push(listener);
      return jest.fn();
    }),
    fireAppActive: () => {
      listeners.forEach((listener) => listener());
    },
  };
  return device;
}

describe('PermissionOnboardingScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    mockBottomInset = 0;
    mockTopInset = 0;
  });

  it('keeps the list between the display cutout and gesture navigation areas', async () => {
    mockTopInset = 24;
    mockBottomInset = 20;
    const device = createDevice(deniedPermissions());

    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    expect(
      StyleSheet.flatten(screen.getByTestId('permission-onboarding-screen').props.style),
    ).toMatchObject({ paddingTop: 24 });
    expect(
      StyleSheet.flatten(screen.getByTestId('permission-list-scroll').props.style),
    ).toMatchObject({ flex: 1 });
    expect(StyleSheet.flatten(screen.getByTestId('permission-footer').props.style)).toMatchObject({
      paddingBottom: 36,
    });
  });

  it('lets permission copy shrink without compressing its action', async () => {
    const device = createDevice(deniedPermissions());

    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    expect(
      StyleSheet.flatten(screen.getByTestId('permission-copy-location_background').props.style),
    ).toMatchObject({ flex: 1, minWidth: 0 });
    expect(
      StyleSheet.flatten(screen.getByTestId('permission-action-location_background').props.style),
    ).toMatchObject({ flexShrink: 0, minWidth: 84 });
    expect(StyleSheet.flatten(screen.getByText('后台定位（始终允许）').props.style)).toMatchObject({
      flexShrink: 1,
    });
  });

  it('shows every permission row with its current status', async () => {
    const device = createDevice({ ...deniedPermissions(), notifications: true, microphone: true });
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );

    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    expect(screen.getByLabelText('通知：已授予')).toBeTruthy();
    expect(screen.getByLabelText('麦克风：已授予')).toBeTruthy();
    expect(screen.getByLabelText('精确闹钟：去开启')).toBeTruthy();
    expect(screen.getByLabelText('后台定位（始终允许）：去开启')).toBeTruthy();
  });

  it('requests a direct-request permission when its row is pressed', async () => {
    const device = createDevice(deniedPermissions());
    const onPermissionsUpdated = jest.fn();
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={onPermissionsUpdated}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByTestId('permission-action-microphone'));
    });

    expect(device.requestPermission).toHaveBeenCalledWith('microphone');
    expect(device.openSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('麦克风：已授予')).toBeTruthy());
    expect(onPermissionsUpdated).toHaveBeenCalledTimes(1);
  });

  it('opens settings for a settings-only permission when its row is pressed', async () => {
    const device = createDevice({ ...deniedPermissions(), notifications: true });
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByTestId('permission-action-exact_alarm'));
    });

    expect(device.openSettings).toHaveBeenCalledWith('exact_alarm');
    expect(device.requestPermission).not.toHaveBeenCalledWith('exact_alarm');
  });

  it('does not call onPermissionsUpdated when the permission stays denied', async () => {
    const device = createDevice(deniedPermissions());
    device.requestPermission = jest.fn(async () => false);
    const onPermissionsUpdated = jest.fn();
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={onPermissionsUpdated}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    await act(async () => {
      fireEvent.press(screen.getByTestId('permission-action-microphone'));
    });

    expect(onPermissionsUpdated).not.toHaveBeenCalled();
    expect(screen.getByLabelText('麦克风：去开启')).toBeTruthy();
  });

  it('keeps background location disabled until foreground location is granted', async () => {
    const device = createDevice({ ...deniedPermissions(), notifications: true });
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    const backgroundButton = screen.getByTestId('permission-action-location_background');
    expect(backgroundButton.props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByTestId('permission-action-location_foreground'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('permission-action-location_background').props.accessibilityState
          .disabled,
      ).toBe(false);
    });
    expect(device.requestPermission).not.toHaveBeenCalledWith('location_background');
  });

  it('disables the continue button until notifications are granted, then calls onContinue', async () => {
    const device = createDevice(deniedPermissions());
    const onContinue = jest.fn();
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={onContinue}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    expect(screen.getByLabelText('进入 App').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByTestId('permission-action-notifications'));
    });
    await waitFor(() =>
      expect(screen.getByLabelText('进入 App').props.accessibilityState.disabled).toBe(false),
    );

    fireEvent.press(screen.getByLabelText('进入 App'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('refreshes status when the app becomes active again (returning from Settings)', async () => {
    const device = createDevice({ ...deniedPermissions(), notifications: true });
    render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalledTimes(1));

    device.status = {
      ...device.status,
      permissions: { ...device.status.permissions, exact_alarm: true },
    };
    await act(async () => {
      device.fireAppActive();
    });

    await waitFor(() => expect(screen.getByLabelText('精确闹钟：已授予')).toBeTruthy());
    expect(device.getStatus).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes from onAppActive on unmount', async () => {
    const device = createDevice(grantedPermissions());
    const unsubscribe = jest.fn();
    device.onAppActive = jest.fn(() => unsubscribe);
    const { unmount } = render(
      <PermissionOnboardingScreen
        device={device}
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('highlights the row named by highlightPermission', async () => {
    const device = createDevice(grantedPermissions());
    render(
      <PermissionOnboardingScreen
        device={device}
        highlightPermission="exact_alarm"
        onContinue={jest.fn()}
        onPermissionsUpdated={jest.fn()}
      />,
    );
    await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

    const row = screen.getByTestId('permission-row-exact_alarm');
    const flatStyle = Array.isArray(row.props.style)
      ? Object.assign({}, ...row.props.style.filter(Boolean))
      : row.props.style;
    expect(flatStyle.borderWidth).toBe(2);
  });

  describe('OEM guidance rows', () => {
    it('shows no OEM rows when no manufacturer is recognized', async () => {
      const device = createDevice(grantedPermissions());
      render(
        <PermissionOnboardingScreen
          device={device}
          onContinue={jest.fn()}
          onPermissionsUpdated={jest.fn()}
        />,
      );
      await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

      expect(screen.queryByTestId('oem-row-autostart')).toBeNull();
      expect(screen.queryByTestId('oem-row-backgroundPopup')).toBeNull();
    });

    it('shows only the autostart row for a non-Xiaomi recognized manufacturer', async () => {
      const device = createDevice(grantedPermissions());
      device.status = {
        ...device.status,
        oemGuidance: { ...device.status.oemGuidance, manufacturer: 'huawei' },
      };
      render(
        <PermissionOnboardingScreen
          device={device}
          onContinue={jest.fn()}
          onPermissionsUpdated={jest.fn()}
        />,
      );
      await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

      expect(screen.getByTestId('oem-row-autostart')).toBeTruthy();
      expect(screen.queryByTestId('oem-row-backgroundPopup')).toBeNull();
    });

    it('shows both the autostart and background-popup rows for Xiaomi', async () => {
      const device = createDevice(grantedPermissions());
      device.status = {
        ...device.status,
        oemGuidance: { ...device.status.oemGuidance, manufacturer: 'xiaomi' },
      };
      render(
        <PermissionOnboardingScreen
          device={device}
          onContinue={jest.fn()}
          onPermissionsUpdated={jest.fn()}
        />,
      );
      await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

      expect(screen.getByTestId('oem-row-autostart')).toBeTruthy();
      expect(screen.getByTestId('oem-row-backgroundPopup')).toBeTruthy();
    });

    it('shows the overlay-failure banner only when lastOverlayFailed is true', async () => {
      const device = createDevice(grantedPermissions());
      device.status = {
        ...device.status,
        oemGuidance: {
          ...device.status.oemGuidance,
          manufacturer: 'xiaomi',
          lastOverlayFailed: true,
        },
      };
      render(
        <PermissionOnboardingScreen
          device={device}
          onContinue={jest.fn()}
          onPermissionsUpdated={jest.fn()}
        />,
      );
      await waitFor(() => expect(device.getStatus).toHaveBeenCalled());

      expect(screen.getByTestId('oem-overlay-failed-banner')).toBeTruthy();
    });

    it('calls openOemSettings and flips the label to "已引导过" after pressing a row', async () => {
      const device = createDevice(grantedPermissions());
      device.status = {
        ...device.status,
        oemGuidance: { ...device.status.oemGuidance, manufacturer: 'xiaomi' },
      };
      const onPermissionsUpdated = jest.fn();
      render(
        <PermissionOnboardingScreen
          device={device}
          onContinue={jest.fn()}
          onPermissionsUpdated={onPermissionsUpdated}
        />,
      );
      await waitFor(() => expect(device.getStatus).toHaveBeenCalled());
      expect(screen.getByLabelText('自启动管理：去看看')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByTestId('oem-action-autostart'));
      });

      expect(device.openOemSettings).toHaveBeenCalledWith('autostart');
      await waitFor(() => expect(screen.getByLabelText('自启动管理：已引导过')).toBeTruthy());
      // 不是真的权限授予，不该触发提醒引擎重建。
      expect(onPermissionsUpdated).not.toHaveBeenCalled();
    });
  });
});
