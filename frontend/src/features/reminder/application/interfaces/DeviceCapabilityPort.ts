export type DevicePermission =
  | 'notifications'
  | 'exact_alarm'
  | 'overlay'
  | 'full_screen'
  | 'battery_optimization'
  | 'location_foreground'
  | 'location_background';

export type DeviceCapabilityStatus = {
  platform: 'android' | 'ios' | 'web' | 'unknown';
  supported: boolean;
  permissions: Readonly<Record<DevicePermission, boolean>>;
  background_execution: boolean;
};

/** 安卓权限读取/申请以及后台能力的边界。 */
export interface DeviceCapabilityPort {
  getStatus(): Promise<DeviceCapabilityStatus>;
  requestPermission(permission: DevicePermission): Promise<boolean>;
  openSettings(permission: DevicePermission): Promise<boolean>;
}
