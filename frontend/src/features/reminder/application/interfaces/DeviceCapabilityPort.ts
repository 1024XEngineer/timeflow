export type DevicePermission =
  | 'notifications'
  | 'exact_alarm'
  | 'overlay'
  | 'full_screen'
  | 'battery_optimization'
  | 'location_foreground'
  | 'location_background'
  | 'microphone';

export type OemManufacturer = 'xiaomi' | 'huawei' | 'oppo' | 'vivo' | null;

/**
 * 国产 ROM 自启动管理 / MIUI 后台弹出界面没有标准 API 能查真实授权状态——这里
 * 只能表达"识别到哪个厂商"和"带没带用户跳过对应设置页"，不是真的 granted/denied。
 */
export type OemGuidance = {
  manufacturer: OemManufacturer;
  autostartGuided: boolean;
  backgroundPopupGuided: boolean;
  /** 上一次响铃悬浮窗是否弹出失败（常见于这两项 OEM 权限没开）。 */
  lastOverlayFailed: boolean;
};

export type DeviceCapabilityStatus = {
  platform: 'android' | 'ios' | 'web' | 'unknown';
  supported: boolean;
  permissions: Readonly<Record<DevicePermission, boolean>>;
  background_execution: boolean;
  oemGuidance: OemGuidance;
};

/** 安卓权限读取/申请以及后台能力的边界。 */
export interface DeviceCapabilityPort {
  getStatus(): Promise<DeviceCapabilityStatus>;
  requestPermission(permission: DevicePermission): Promise<boolean>;
  openSettings(permission: DevicePermission): Promise<boolean>;
  /**
   * 跳转国产 ROM 私有设置页；kind 没有真的授权状态可查，返回值只表示 Intent
   * 有没有跳转成功，不代表用户真的开启了对应权限。
   */
  openOemSettings(kind: 'autostart' | 'backgroundPopup'): Promise<boolean>;
  /** 订阅应用回到前台；返回取消订阅函数。 */
  onAppActive(listener: () => void): () => void;
}
