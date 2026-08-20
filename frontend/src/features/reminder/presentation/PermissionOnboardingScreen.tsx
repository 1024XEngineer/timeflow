import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type {
  DeviceCapabilityPort,
  DeviceCapabilityStatus,
  DevicePermission,
} from '../application/interfaces';
import { colors, spacing } from '../../../shared/ui/theme';

type PermissionRow = {
  permission: DevicePermission;
  title: string;
  description: string;
  required?: boolean;
  /** Android 只允许在这个权限已授予后才能申请当前行（比如后台定位需要先有前台定位）。 */
  disabledUntil?: DevicePermission;
};

const ROWS: readonly PermissionRow[] = [
  {
    permission: 'notifications',
    title: '通知',
    description: '提醒到点或到达地点时弹出通知，是所有提醒功能的基础。',
    required: true,
  },
  {
    permission: 'microphone',
    title: '麦克风',
    description: '按住说话或连续对话时用来录音。',
  },
  {
    permission: 'location_foreground',
    title: '定位',
    description: '创建到达/离开地点的提醒时，用来记录当前位置。',
  },
  {
    permission: 'location_background',
    title: '后台定位（始终允许）',
    description: '退出 App 后地点提醒仍能在你进出范围时触发。',
    disabledUntil: 'location_foreground',
  },
  {
    permission: 'exact_alarm',
    title: '精确闹钟',
    description: '让时间提醒能在设定的准确时间响铃。',
  },
  {
    permission: 'overlay',
    title: '显示在其他应用上层',
    description: '闹钟响铃时能在其他 App 上方弹出止铃界面。',
  },
  {
    permission: 'full_screen',
    title: '全屏通知',
    description: '锁屏或息屏时也能直接显示响铃界面。',
  },
  {
    permission: 'battery_optimization',
    title: '忽略电池优化',
    description: '避免系统在后台清理闹钟/围栏相关进程。',
  },
];

/** 这几项有系统授权框，点了直接申请；其余没有授权框，只能跳系统设置页。 */
const DIRECT_REQUEST: ReadonlySet<DevicePermission> = new Set([
  'notifications',
  'microphone',
  'location_foreground',
  'location_background',
]);

type OemRowConfig = {
  kind: 'autostart' | 'backgroundPopup';
  title: string;
  description: string;
  /** 只有小米有这一项；其余厂商没有对应设置页。 */
  xiaomiOnly?: boolean;
};

const OEM_ROWS: readonly OemRowConfig[] = [
  {
    kind: 'autostart',
    title: '自启动管理',
    description:
      '额外保障，不是标准 Android 权限：允许自启动后，提醒更容易在后台按时触发。是否生效以设备为准。',
  },
  {
    kind: 'backgroundPopup',
    title: '后台弹出界面',
    description:
      '额外保障，MIUI 特有设置：开启后，闹钟响铃时更容易弹出止铃界面。是否生效以设备为准。',
    xiaomiOnly: true,
  },
];

/**
 * 登录后的权限列表页：逐项展示状态，点了才申请对应权限，不再自动串行弹框。
 * 只有通知是硬性门槛，其余权限允许先跳过，缺的功能会在用到时单独引导。
 */
export function PermissionOnboardingScreen({
  device,
  highlightPermission,
  onContinue,
  onPermissionsUpdated,
}: {
  readonly device: DeviceCapabilityPort;
  readonly highlightPermission?: DevicePermission | null;
  readonly onContinue: () => void;
  readonly onPermissionsUpdated: () => void;
}) {
  const [status, setStatus] = useState<DeviceCapabilityStatus | null>(null);
  const [busyPermission, setBusyPermission] = useState<DevicePermission | null>(null);
  const [busyOemKind, setBusyOemKind] = useState<'autostart' | 'backgroundPopup' | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<DeviceCapabilityStatus> => {
    const next = await device.getStatus();
    if (mountedRef.current) setStatus(next);
    return next;
  }, [device]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    // 从系统设置页返回时刷新一遍，跟旧的 useReminderPermissionsOnLaunch 用的是
    // 同一个 onAppActive 机制，但这里只是重新读状态，不会自动弹下一个权限框。
    const unsubscribe = device.onAppActive(() => {
      void refresh();
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [device, refresh]);

  const handlePress = useCallback(
    async (permission: DevicePermission) => {
      if (busyPermission != null) return;
      setBusyPermission(permission);
      try {
        const wasGranted = status?.permissions[permission] ?? false;
        if (DIRECT_REQUEST.has(permission)) {
          await device.requestPermission(permission);
        } else {
          await device.openSettings(permission);
        }
        const next = await refresh();
        if (!wasGranted && next.permissions[permission]) {
          onPermissionsUpdated();
        }
      } finally {
        if (mountedRef.current) setBusyPermission(null);
      }
    },
    [busyPermission, device, onPermissionsUpdated, refresh, status],
  );

  const handleOemPress = useCallback(
    async (kind: 'autostart' | 'backgroundPopup') => {
      if (busyOemKind != null) return;
      setBusyOemKind(kind);
      try {
        await device.openOemSettings(kind);
        await refresh();
      } finally {
        if (mountedRef.current) setBusyOemKind(null);
      }
    },
    [busyOemKind, device, refresh],
  );

  const notificationsGranted = status?.permissions.notifications ?? false;
  const oemGuidance = status?.oemGuidance;
  const oemRows = OEM_ROWS.filter((row) => {
    if (oemGuidance?.manufacturer == null) return false;
    if (row.xiaomiOnly) return oemGuidance.manufacturer === 'xiaomi';
    return true;
  });

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>需要这些权限</Text>
        <Text style={styles.subtitle}>
          点击每一项单独开启；通知是必需的，其余可以先跳过，用到对应功能时会再提醒你。
        </Text>
        {ROWS.map((row) => {
          const granted = status?.permissions[row.permission] ?? false;
          const blocked =
            row.disabledUntil != null && !(status?.permissions[row.disabledUntil] ?? false);
          const highlighted = highlightPermission === row.permission;
          const busy = busyPermission === row.permission;

          return (
            <View
              key={row.permission}
              style={[styles.row, highlighted ? styles.rowHighlighted : null]}
              testID={`permission-row-${row.permission}`}
            >
              <View style={styles.rowText}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowTitle}>{row.title}</Text>
                  {row.required ? <Text style={styles.requiredBadge}>必需</Text> : null}
                </View>
                <Text style={styles.rowDescription}>{row.description}</Text>
                {blocked ? <Text style={styles.rowBlockedHint}>需要先开启上面的“定位”</Text> : null}
              </View>
              <Pressable
                accessibilityLabel={`${row.title}：${granted ? '已授予' : '去开启'}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: granted || blocked || busy }}
                disabled={granted || blocked || busy}
                onPress={() => void handlePress(row.permission)}
                style={[styles.actionButton, granted ? styles.actionButtonGranted : null]}
                testID={`permission-action-${row.permission}`}
              >
                {busy ? (
                  <ActivityIndicator color={colors.onPrimary} size="small" />
                ) : (
                  <Text style={granted ? styles.actionTextGranted : styles.actionText}>
                    {granted ? '已授予' : '去开启'}
                  </Text>
                )}
              </Pressable>
            </View>
          );
        })}
        {oemRows.length > 0 ? (
          <>
            {oemGuidance?.lastOverlayFailed ? (
              <View style={styles.oemFailureBanner} testID="oem-overlay-failed-banner">
                <Text style={styles.oemFailureBannerText}>
                  上次响铃时没能弹出止铃界面，可能是下面这两项没开，去检查一下？
                </Text>
              </View>
            ) : null}
            {oemRows.map((row) => {
              const guided =
                row.kind === 'autostart'
                  ? (oemGuidance?.autostartGuided ?? false)
                  : (oemGuidance?.backgroundPopupGuided ?? false);
              const busy = busyOemKind === row.kind;

              return (
                <View key={row.kind} style={styles.row} testID={`oem-row-${row.kind}`}>
                  <View style={styles.rowText}>
                    <View style={styles.rowTitleLine}>
                      <Text style={styles.rowTitle}>{row.title}</Text>
                      <Text style={styles.oemBadge}>额外保障</Text>
                    </View>
                    <Text style={styles.rowDescription}>{row.description}</Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`${row.title}：${guided ? '已引导过' : '去看看'}`}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    onPress={() => void handleOemPress(row.kind)}
                    style={styles.actionButton}
                    testID={`oem-action-${row.kind}`}
                  >
                    {busy ? (
                      <ActivityIndicator color={colors.onPrimary} size="small" />
                    ) : (
                      <Text style={styles.actionText}>{guided ? '已引导过' : '去看看'}</Text>
                    )}
                  </Pressable>
                </View>
              );
            })}
          </>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        {!notificationsGranted ? (
          <Text style={styles.footerHint}>需要先开启通知权限才能进入</Text>
        ) : null}
        <Pressable
          accessibilityLabel="进入 App"
          accessibilityRole="button"
          accessibilityState={{ disabled: !notificationsGranted }}
          disabled={!notificationsGranted}
          onPress={onContinue}
          style={[
            styles.continueButton,
            !notificationsGranted ? styles.continueButtonDisabled : null,
          ]}
        >
          <Text style={styles.continueText}>进入 App</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    backgroundColor: colors.text,
    borderRadius: 8,
    minWidth: 84,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionButtonGranted: {
    backgroundColor: colors.accent,
  },
  actionText: {
    color: colors.onPrimary,
    fontWeight: '700',
    textAlign: 'center',
  },
  actionTextGranted: {
    color: colors.text,
    fontWeight: '700',
    textAlign: 'center',
  },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
  },
  continueButton: {
    backgroundColor: colors.text,
    borderRadius: 10,
    paddingVertical: spacing.md,
  },
  continueButtonDisabled: {
    backgroundColor: colors.border,
  },
  continueText: {
    color: colors.onPrimary,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  footer: {
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    padding: spacing.lg,
  },
  footerHint: {
    color: colors.mutedText,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  oemBadge: {
    backgroundColor: colors.input,
    borderRadius: 4,
    color: colors.mutedText,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  oemFailureBanner: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    padding: spacing.md,
  },
  oemFailureBannerText: {
    color: colors.text,
    fontSize: 13,
  },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBlockedHint: {
    color: colors.mutedText,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  rowDescription: {
    color: colors.mutedText,
    fontSize: 13,
  },
  rowHighlighted: {
    borderColor: colors.focus,
    borderWidth: 2,
  },
  rowText: {
    flex: 1,
    gap: spacing.xs,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  rowTitleLine: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  requiredBadge: {
    backgroundColor: colors.accent,
    borderRadius: 4,
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  subtitle: {
    color: colors.mutedText,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
});
