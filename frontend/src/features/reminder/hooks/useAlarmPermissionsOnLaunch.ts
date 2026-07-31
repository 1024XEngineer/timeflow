import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { useAppDialog } from '@/shared/components/AppDialogProvider';

import {
  getAndroidAlarmPermissionStatus,
  isAndroidAlarmSupported,
  openAndroidAlarmPermissionSettings,
  requestAndroidNotificationPermission,
} from '../native/alarmScheduler';

type PermissionKind = 'notifications' | 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery';

const PERMISSION_PROMPTS: Record<
  PermissionKind,
  {
    title: string;
    message: string;
    settingsKind?: 'exactAlarm' | 'overlay' | 'fullScreen' | 'battery';
  }
> = {
  notifications: {
    title: '需要通知权限',
    message: '允许通知后，日程闹钟才能弹出提醒并播放语音。',
  },
  exactAlarm: {
    title: '需要精确闹钟权限',
    message: '允许后，日程提醒才能在设定时间准时触发。',
    settingsKind: 'exactAlarm',
  },
  overlay: {
    title: '需要悬浮窗权限',
    message: '允许“显示在其他应用上层”后，才能在其他 App 上方显示停止闹钟界面。',
    settingsKind: 'overlay',
  },
  fullScreen: {
    title: '需要全屏通知权限',
    message: '允许后，锁屏或息屏时可以直接显示响铃页面。',
    settingsKind: 'fullScreen',
  },
  battery: {
    title: '需要忽略电池优化',
    message: '关闭电池优化可以减少系统清理闹钟进程的概率。',
    settingsKind: 'battery',
  },
};

async function nextMissingPermission(skipped: Set<PermissionKind>): Promise<PermissionKind | null> {
  const status = await getAndroidAlarmPermissionStatus();
  if (!status) return null;
  const order: PermissionKind[] = [
    'notifications',
    'exactAlarm',
    'overlay',
    'fullScreen',
    'battery',
  ];
  for (const kind of order) {
    if (skipped.has(kind)) continue;
    if (kind === 'notifications' && !status.notifications) return kind;
    if (kind === 'exactAlarm' && !status.exactAlarm) return kind;
    if (kind === 'overlay' && !status.overlay) return kind;
    if (kind === 'fullScreen' && !status.fullScreen) return kind;
    if (kind === 'battery' && !status.battery) return kind;
  }
  return null;
}

/**
 * 进入 App 时按文档逐项申请闹钟相关权限；用户从设置返回后再继续下一项。
 * 创建日程时不再弹授权。
 */
export function useAlarmPermissionsOnLaunch() {
  const { confirm } = useAppDialog();
  const busyRef = useRef(false);
  const awaitingReturnRef = useRef(false);
  const skippedRef = useRef(new Set<PermissionKind>());

  useEffect(() => {
    if (Platform.OS !== 'android' || !isAndroidAlarmSupported()) return;

    const runPrompt = () => {
      void promptNext().catch(() => {
        // Permission APIs are host-owned; a rejected prompt must not become an
        // unhandled promise from a timer or AppState callback.
        busyRef.current = false;
      });
    };

    const promptNext = async () => {
      if (busyRef.current) return;
      busyRef.current = true;

      try {
        const missing = await nextMissingPermission(skippedRef.current);
        if (!missing) return;

        const prompt = PERMISSION_PROMPTS[missing];

        if (missing === 'notifications') {
          await requestAndroidNotificationPermission();
          // 给系统权限弹窗一点时间；若仍未授权则本会话跳过，避免死循环
          const status = await getAndroidAlarmPermissionStatus();
          if (status && !status.notifications) {
            skippedRef.current.add('notifications');
          }
          busyRef.current = false;
          setTimeout(() => {
            runPrompt();
          }, 350);
          return;
        }

        const shouldAuthorize = await confirm({
          title: prompt.title,
          message: prompt.message,
          confirmLabel: '去授权',
          cancelLabel: '暂不',
        });
        if (!shouldAuthorize) {
          skippedRef.current.add(missing);
        } else {
          awaitingReturnRef.current = true;
          await openAndroidAlarmPermissionSettings(prompt.settingsKind!);
        }
      } finally {
        busyRef.current = false;
      }

      if (!awaitingReturnRef.current) {
        setTimeout(() => {
          runPrompt();
        }, 200);
      }
    };

    const onAppStateChange = (state: AppStateStatus) => {
      if (state !== 'active') return;
      if (!awaitingReturnRef.current) return;
      awaitingReturnRef.current = false;
      setTimeout(() => {
        runPrompt();
      }, 300);
    };

    const timer = setTimeout(() => {
      runPrompt();
    }, 600);
    const subscription = AppState.addEventListener('change', onAppStateChange);

    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [confirm]);
}
