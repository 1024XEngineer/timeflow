import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * 启动时申请前台/后台定位权限，保证地点提醒在授权后可以挂上围栏。
 * 通过 DeviceCapabilityPort 的闹钟权限引导见独立 PR。
 */
export function useLocationPermissionsOnLaunch(): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void requestLocationPermissions();
  }, []);
}

async function requestLocationPermissions(): Promise<void> {
  try {
    // Lazy require keeps the native module optional and mockable in Jest.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Location = require('expo-location') as typeof import('expo-location');
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== Location.PermissionStatus.GRANTED) {
      return;
    }
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      await Location.requestBackgroundPermissionsAsync();
    }
  } catch {
    // 无原生模块或用户拒绝时不阻断启动。
  }
}
