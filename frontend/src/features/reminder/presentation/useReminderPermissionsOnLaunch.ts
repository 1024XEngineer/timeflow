import { useEffect, useRef } from 'react';

import type {
  AlertDialogPort,
  DeviceCapabilityPort,
  DevicePermission,
} from '../application/interfaces';

const ANDROID_ALARM_ORDER: DevicePermission[] = [
  'notifications',
  'exact_alarm',
  'overlay',
  'full_screen',
  'battery_optimization',
];

const LOCATION_ORDER: DevicePermission[] = ['location_foreground', 'location_background'];

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
  location_foreground: {
    title: '需要定位权限',
    message: '允许定位后，才能根据你是否到达或离开地点触发提醒。',
  },
  location_background: {
    title: '需要后台定位权限',
    message: '允许“始终允许”定位后，应用在后台也能接收地理围栏进出事件。',
  },
};

/** 仅通知可在无前置说明时直接弹系统框；定位需先说明，且常要回落设置页。 */
const DIRECT_REQUEST: ReadonlySet<DevicePermission> = new Set(['notifications']);

/** 精确闹钟没有系统授权框，只能跳设置页；先弹说明框会多一步点击，直接跳过去。 */
const DIRECT_SETTINGS: ReadonlySet<DevicePermission> = new Set(['exact_alarm']);

const LOCATION_PERMISSIONS: ReadonlySet<DevicePermission> = new Set([
  'location_foreground',
  'location_background',
]);

/**
 * 启动时逐项申请提醒相关权限；通过 DeviceCapabilityPort / AlertDialogPort 访问平台，
 * 不在 UI 层直接依赖 react-native。
 *
 * - Android（alarm 能力可用）：闹钟相关权限 + 定位权限
 * - 其它平台 / alarm 不可用：仍申请定位权限，保证地点提醒链路可授权
 *
 * @param onPermissionsUpdated 某项权限刚授权成功时回调（用于重建围栏/闹钟）。
 */
export function useReminderPermissionsOnLaunch(
  device: DeviceCapabilityPort | null,
  dialog: AlertDialogPort | null,
  onPermissionsUpdated?: () => void,
): void {
  const busyRef = useRef(false);
  const awaitingReturnRef = useRef(false);
  const awaitingPermissionRef = useRef<DevicePermission | null>(null);
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
      if (busyRef.current || cancelled || awaitingReturnRef.current) return;
      busyRef.current = true;
      let queueNext = false;

      try {
        const status = await device.getStatus();
        if (status.platform === 'web' || status.platform === 'unknown') return;

        const missing = nextMissingPermission(status);
        if (missing == null) return;

        const prompt = PERMISSION_PROMPTS[missing];
        /* istanbul ignore next -- PERMISSION_PROMPTS has an entry for every current
         * DevicePermission; this only guards a future permission added to the union
         * without a matching prompt, which can't happen with today's types. */
        if (prompt == null) {
          skippedRef.current.add(missing);
          queueNext = true;
          return;
        }

        // 通知：直接系统授权框。
        if (DIRECT_REQUEST.has(missing)) {
          const granted = await device.requestPermission(missing);
          if (!granted) {
            skippedRef.current.add(missing);
          } else {
            onPermissionsUpdated?.();
          }
          queueNext = true;
          return;
        }

        // 精确闹钟没有系统授权框，只能跳设置页，先弹说明框只会多一次点击，直接跳过去。
        if (DIRECT_SETTINGS.has(missing)) {
          awaitingReturnRef.current = true;
          awaitingPermissionRef.current = missing;
          const opened = await device.openSettings(missing);
          if (!opened) {
            awaitingReturnRef.current = false;
            awaitingPermissionRef.current = null;
            skippedRef.current.add(missing);
            queueNext = true;
          }
          return;
        }

        const shouldAuthorize = await confirmAsync(dialog, prompt.title, prompt.message);
        if (!shouldAuthorize) {
          skippedRef.current.add(missing);
          queueNext = true;
          return;
        }

        // 定位：先等应用内说明框关掉，再申请系统权限；失败则跳转设置，避免“点了没反应还连弹”。
        if (LOCATION_PERMISSIONS.has(missing)) {
          await delay(350);
          const granted = await device.requestPermission(missing);
          if (granted) {
            onPermissionsUpdated?.();
            queueNext = true;
            return;
          }
          awaitingReturnRef.current = true;
          awaitingPermissionRef.current = missing;
          const opened = await device.openSettings(missing);
          if (!opened) {
            awaitingReturnRef.current = false;
            awaitingPermissionRef.current = null;
            skippedRef.current.add(missing);
            queueNext = true;
          }
          return;
        }

        // 精确闹钟 / 悬浮窗等：跳转系统设置，回来后再继续。
        awaitingReturnRef.current = true;
        awaitingPermissionRef.current = missing;
        const opened = await device.openSettings(missing);
        if (!opened) {
          awaitingReturnRef.current = false;
          awaitingPermissionRef.current = null;
          skippedRef.current.add(missing);
          queueNext = true;
        }
      } finally {
        busyRef.current = false;
        // 必须放在 finally 里：try 里几乎每条分支（直接请求、跳设置、弹框拒绝、
        // 定位授权/回退）都在分支末尾 return，放在 try/finally 外面的话，只有
        // 悬浮窗/全屏通知/电池优化这种"用户点了确认"的兜底分支能落到这行——
        // 其余分支设了 queueNext 也没人来消费，链就断在第一个权限上。
        if (queueNext && !awaitingReturnRef.current) {
          setTimeout(runPrompt, 250);
        }
      }
    };

    const nextMissingPermission = (
      status: Awaited<ReturnType<DeviceCapabilityPort['getStatus']>>,
    ): DevicePermission | null => {
      if (status.platform === 'android' && status.supported) {
        const alarmMissing = ANDROID_ALARM_ORDER.find((permission) => {
          if (skippedRef.current.has(permission)) return false;
          return !status.permissions[permission];
        });
        if (alarmMissing != null) return alarmMissing;
      }

      return (
        LOCATION_ORDER.find((permission) => {
          if (skippedRef.current.has(permission)) return false;
          return !status.permissions[permission];
        }) ?? null
      );
    };

    const unsubscribe = device.onAppActive(() => {
      if (!awaitingReturnRef.current) return;
      awaitingReturnRef.current = false;
      const pending = awaitingPermissionRef.current;
      awaitingPermissionRef.current = null;
      void device
        .getStatus()
        .then((status) => {
          if (pending != null && !status.permissions[pending]) {
            // Returning from settings without changing the permission must not
            // reopen the same dialog in a loop. The next explicit permission
            // action can start a fresh attempt.
            skippedRef.current.add(pending);
          } else if (pending != null) {
            onPermissionsUpdated?.();
          }
          setTimeout(runPrompt, 300);
        })
        .catch(() => {
          if (pending != null) skippedRef.current.add(pending);
          setTimeout(runPrompt, 300);
        });
    });

    const timer = setTimeout(runPrompt, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
      // device 变 null（登出）时这个 effect 会重跑清理：不重置的话，刚好卡在
      // "等用户从设置页返回"这一步登出的账号，会让下次登录后的新一轮 promptNext()
      // 一直读到陈旧的 true 直接返回——不会再有新的 onAppActive 事件来清掉它
      // （应用早就是 active 的），所有权限提示永久失效，直到进程重启。
      awaitingReturnRef.current = false;
      awaitingPermissionRef.current = null;
      skippedRef.current = new Set();
    };
  }, [device, dialog, onPermissionsUpdated]);
}

function confirmAsync(dialog: AlertDialogPort, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void dialog.show({
      title,
      message,
      cancelable: true,
      onDismiss: () => finish(false),
      buttons: [
        { text: '暂不', style: 'cancel', onPress: () => finish(false) },
        { text: '去授权', onPress: () => finish(true) },
      ],
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
