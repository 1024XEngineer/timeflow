import type {
  DeviceCapabilityPort,
  DeviceCapabilityStatus,
  DevicePermission,
} from '../../features/reminder/application/interfaces';

const MOCK_PERMISSIONS: Readonly<Record<DevicePermission, boolean>> = {
  notifications: true,
  exact_alarm: true,
  overlay: false,
  full_screen: true,
  battery_optimization: false,
  location_foreground: true,
  location_background: false,
};

const MOCK_STATUS: DeviceCapabilityStatus = {
  platform: 'android',
  supported: true,
  permissions: MOCK_PERMISSIONS,
  background_execution: false,
};

/** 原生模块接入前使用的固定设备能力状态。 */
export class MockDeviceCapability implements DeviceCapabilityPort {
  async getStatus(): Promise<DeviceCapabilityStatus> {
    return { ...MOCK_STATUS, permissions: { ...MOCK_STATUS.permissions } };
  }

  async requestPermission(permission: DevicePermission): Promise<boolean> {
    // 与 getStatus() 保持一致：返回该权限的固定值，不假装 grant 成功。
    return MOCK_PERMISSIONS[permission];
  }

  async openSettings(_permission: DevicePermission): Promise<boolean> {
    return true;
  }

  onAppActive(_listener: () => void): () => void {
    return () => undefined;
  }
}

export { MOCK_STATUS as MOCK_DEVICE_CAPABILITY_STATUS };
