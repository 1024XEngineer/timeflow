import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LocationScheduleView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';

export function LocationScheduleDetailSheet({
  schedule,
  onClose,
}: {
  schedule: LocationScheduleView | null;
  onClose: () => void;
}) {
  return (
    <Modal animationType="slide" transparent visible={schedule !== null} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.heading}>日程详情</Text>
            <Pressable accessibilityLabel="关闭详情" accessibilityRole="button" onPress={onClose}>
              <Text style={styles.close}>关闭</Text>
            </Pressable>
          </View>
          {schedule ? (
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={styles.title}>{schedule.title}</Text>
              <Detail label="类型" value="地点日程" />
              <Detail label="地点" value={schedule.locationName ?? '未命名地点'} />
              <Detail label="时区" value={schedule.timezone} />
              <Detail label="提醒类型" value={schedule.reminderType ?? '未配置'} />
              <Detail label="提醒强度" value={schedule.reminderStrength ?? '未配置'} />
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'flex-end' },
  close: { color: colors.focus, fontSize: 15, fontWeight: '700' },
  content: { gap: spacing.md, paddingBottom: spacing.xl },
  detail: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
    paddingBottom: spacing.sm,
  },
  header: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  heading: { color: colors.text, fontSize: 18, fontWeight: '700' },
  label: { color: colors.mutedText, fontSize: 12, fontWeight: '600' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    padding: spacing.lg,
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: spacing.sm },
  value: { color: colors.text, fontSize: 16 },
});
