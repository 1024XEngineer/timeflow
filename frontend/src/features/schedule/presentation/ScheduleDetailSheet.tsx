import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../../../shared/ui/theme';

export function ScheduleDetailSheet({
  children,
  onClose,
  title,
  visible,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.eyebrow}>日程详情</Text>
            <Pressable
              accessibilityLabel="关闭详情"
              accessibilityRole="button"
              hitSlop={4}
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeIcon}>×</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={[
              styles.content,
              { paddingBottom: Math.max(spacing.xl, insets.bottom + spacing.md) },
            ]}
            showsVerticalScrollIndicator={false}
            testID="schedule-detail-content"
          >
            <View style={styles.titleBlock}>
              <Text style={styles.title}>{title}</Text>
            </View>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function DetailSection({
  icon,
  label,
  primary,
  secondary,
}: {
  icon: string;
  label: string;
  primary: string;
  secondary?: string;
}) {
  return (
    <View style={styles.section}>
      <View accessible={false} style={styles.sectionIcon}>
        <Text style={styles.sectionIconText}>{icon}</Text>
      </View>
      <View style={styles.sectionCopy}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <Text style={styles.sectionPrimary}>{primary}</Text>
        {secondary ? <Text style={styles.sectionSecondary}>{secondary}</Text> : null}
      </View>
    </View>
  );
}

export function DetailMeta({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <View style={styles.meta}>
      <Text accessible={false} style={styles.metaIcon}>
        {icon}
      </Text>
      <Text style={styles.metaText}>{children}</Text>
    </View>
  );
}

export function normalizeDetailText(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function formatReminderDetail(type: string | null, strength: string | null) {
  if (!type && !strength) return null;
  const typeLabels: Record<string, string> = {
    arrive_location: '到达地点时',
    at_time: '日程开始时',
    before_start: '日程开始前',
    return_to_recorded_location: '返回记录地点时',
  };
  const strengthLabels: Record<string, string> = {
    high: '强提醒',
    low: '轻柔提醒',
    medium: '标准提醒',
  };
  return {
    primary: type ? (typeLabels[type] ?? type) : (strengthLabels[strength ?? ''] ?? strength ?? ''),
    secondary: type && strength ? `提醒强度 · ${strengthLabels[strength] ?? strength}` : undefined,
  };
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(18, 53, 45, 0.32)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: colors.input,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  closeIcon: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '300',
    lineHeight: 30,
    marginTop: -2,
  },
  content: { gap: spacing.md, paddingBottom: spacing.xl },
  eyebrow: { color: colors.mutedText, fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.border,
    borderRadius: 2,
    height: 4,
    marginTop: spacing.sm,
    width: 38,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 56,
  },
  meta: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
  },
  metaIcon: { color: colors.mutedText, fontSize: 15 },
  metaText: { color: colors.mutedText, flex: 1, fontSize: 12 },
  pressed: { opacity: 0.62 },
  section: {
    alignItems: 'flex-start',
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  sectionCopy: { flex: 1, minWidth: 0 },
  sectionIcon: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 12,
    height: 38,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 38,
  },
  sectionIconText: {
    color: colors.text,
    fontSize: 18,
    height: 18,
    includeFontPadding: false,
    lineHeight: 18,
    textAlign: 'center',
    textAlignVertical: 'center',
  },
  sectionLabel: { color: colors.mutedText, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  sectionPrimary: { color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  sectionSecondary: { color: colors.mutedText, fontSize: 13, lineHeight: 19, marginTop: 3 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '88%',
    maxWidth: 640,
    paddingHorizontal: spacing.lg,
    width: '100%',
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', lineHeight: 36 },
  titleBlock: { gap: spacing.md, paddingBottom: spacing.sm, paddingTop: spacing.xs },
});
