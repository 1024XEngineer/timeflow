import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ScheduleOccurrenceView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import { formatRange } from './scheduleDisplay';

export function ScheduleOccurrenceRow({
  item,
  onPress,
}: {
  item: ScheduleOccurrenceView;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${formatRange(item)} ${item.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.dot, item.isAllDay && styles.allDayDot]} />
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.range}>{formatRange(item)}</Text>
        {item.locationName ? <Text style={styles.meta}>{item.locationName}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  allDayDot: { backgroundColor: colors.accent },
  copy: { flex: 1, gap: 4 },
  dot: { backgroundColor: colors.focus, borderRadius: 8, height: 12, marginTop: 4, width: 12 },
  meta: { color: colors.mutedText, fontSize: 13 },
  pressed: { opacity: 0.7 },
  range: { color: colors.mutedText, fontSize: 13, fontWeight: '600' },
  row: {
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
