import { useEffect, useRef } from 'react';
import { Alert, Platform } from 'react-native';

import {
  baiduSetAgreePrivacy,
  persistBaiduPrivacyConsent,
  readBaiduPrivacyConsent,
} from '../../../infrastructure/location/native/BaiduLocationBridge';

/**
 * 启动时申请前台/后台定位权限，并在 Android 上单独确认百度隐私条款。
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
    if (Platform.OS === 'android') {
      await requestBaiduPrivacyConsent();
    }
  } catch {
    // 无原生模块或用户拒绝时不阻断启动。
  }
}

async function requestBaiduPrivacyConsent(): Promise<void> {
  if (await readBaiduPrivacyConsent()) {
    await baiduSetAgreePrivacy(true);
    return;
  }
  const agreed = await confirmBaiduPrivacy();
  if (!agreed) return;
  await persistBaiduPrivacyConsent(true);
  await baiduSetAgreePrivacy(true);
}

function confirmBaiduPrivacy(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(
      '百度定位隐私政策',
      '地点提醒需要使用百度定位服务。是否同意其隐私政策？',
      [
        { text: '不同意', style: 'cancel', onPress: () => finish(false) },
        { text: '同意', onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
