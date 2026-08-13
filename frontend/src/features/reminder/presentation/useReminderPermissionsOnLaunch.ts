import { useEffect, useRef } from 'react';

import type {
  AlertDialogPort,
  DeviceCapabilityPort,
  DevicePermission,
} from '../application/interfaces';

const PERMISSION_ORDER: DevicePermission[] = [
  'notifications',
  'exact_alarm',
  'overlay',
  'full_screen',
  'battery_optimization',
];

const PERMISSION_PROMPTS: Partial<Record<DevicePermission, { title: string; message: string }>> = {
  notifications: {
    title: '需要通知权限',
    message: '允许通知后，日程闹钟才能弹出提醒并播放语音。',
  },
  exact_alarm: {
    title: '需要精确闹钟权限',
    message: '允许后，日程提醒才能在设定时间准时触发。',
  },
  overlay: {
    title: '需要悬浮窗权限',
    message: '允许“显示在其他应用上层”后，才能在其他 App 上方显示停止闹钟界面。',
  },
  full_screen: {
    title: '需要全屏通知权限',
    message: '允许后，锁屏或息屏时可以直接显示响铃页面。',
  },
  battery_optimization: {
    title: '需要忽略电池优化',
    message: '关闭电池优化可以减少系统清理闹钟进程的概率。',
  },
};

/**
 * 启动时逐项申请提醒相关权限；通过 DeviceCapabilityPort / AlertDialogPort 访问平台，
 * 不在 UI 层直接依赖 react-native。
 */
export function useReminderPermissionsOnLaunch(
  device: DeviceCapabilityPort | null,
  dialog: AlertDialogPort | null,
): void {
  const busyRef = useRef(false);
  const awaitingReturnRef = useRef(false);
  const skippedRef = useRef(new Set<DevicePermission>());

  useEffect(() => {
    if (device == null || dialog == null) return;

    let cancelled = false;

    const runPrompt = () => {
      if (cancelled) return;
      void promptNext().catch(() => {
        busyRef.current = false;
      });
    };

    const promptNext = async () => {
      if (busyRef.current || cancelled) return;
      busyRef.current = true;

      try {
        const status = await device.getStatus();
        if (status.platform !== 'android' || !status.supported) return;

        const missing = PERMISSION_ORDER.find((permission) => {
          if (skippedRef.current.has(permission)) return false;
          return !status.permissions[permission];
        });
        if (missing == null) return;

        const prompt = PERMISSION_PROMPTS[missing];
        if (prompt == null) {
          skippedRef.current.add(missing);
          return;
        }

        if (missing === 'notifications') {
          const granted = await device.requestPermission('notifications');
          if (!granted) skippedRef.current.add('notifications');
          busyRef.current = false;
          setTimeout(runPrompt, 350);
          return;
        }

        const shouldAuthorize = await confirmAsync(dialog, prompt.title, prompt.message);
        if (!shouldAuthorize) {
          skippedRef.current.add(missing);
        } else {
          awaitingReturnRef.current = true;
          await device.openSettings(missing);
        }
      } finally {
        busyRef.current = false;
      }

      if (!awaitingReturnRef.current) {
        setTimeout(runPrompt, 200);
      }
    };

    const unsubscribe = device.onAppActive(() => {
      if (!awaitingReturnRef.current) return;
      awaitingReturnRef.current = false;
      setTimeout(runPrompt, 300);
    });

    const timer = setTimeout(runPrompt, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [device, dialog]);
}

function confirmAsync(dialog: AlertDialogPort, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    void dialog.show({
      title,
      message,
      buttons: [
        { text: '暂不', style: 'cancel', onPress: () => resolve(false) },
        { text: '去授权', onPress: () => resolve(true) },
      ],
    });
  });
}
