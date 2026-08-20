import { useEffect } from 'react';

import type {
  AlertDialogPort,
  DevicePermission,
  ReminderApplicationPort,
} from '../application/interfaces';

const PERMISSION_LABELS: Record<DevicePermission, string> = {
  notifications: '通知',
  microphone: '麦克风',
  location_foreground: '定位',
  location_background: '后台定位',
  exact_alarm: '精确闹钟',
  overlay: '显示在其他应用上层',
  full_screen: '全屏通知',
  battery_optimization: '忽略电池优化',
};

/**
 * 语音创建的提醒是异步落地的（服务端解析完、本地引擎才尝试挂闹钟/围栏），
 * 没有同步的按钮点击时刻可以在创建前拦截缺权限的情况——所以改成创建后提示：
 * 记录正常建好，引擎发现缺权限就跳过挂载，这里订阅那个信号，弹一次合并提示。
 */
export function useReminderPermissionNudge(
  reminder: ReminderApplicationPort,
  dialog: AlertDialogPort,
  onRequestPermission: (permission?: DevicePermission) => void,
): void {
  useEffect(() => {
    return reminder.onPermissionBlocked((event) => {
      if (event.missing.length === 0) return;
      const names = event.missing.map((permission) => PERMISSION_LABELS[permission]).join('、');
      void dialog.show({
        title: '提醒已创建',
        message: `但还缺${names}权限，可能收不到或看不到这条提醒。现在去开启吗？`,
        cancelable: true,
        buttons: [
          { text: '暂不', style: 'cancel' },
          { text: '去开启', onPress: () => onRequestPermission(event.missing[0]) },
        ],
      });
    });
  }, [reminder, dialog, onRequestPermission]);
}
