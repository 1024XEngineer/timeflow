import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ScheduleOccurrenceView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import { formatRange, formatTime } from './scheduleDisplay';

export function ScheduleOccurrenceRow({
  item,
  onPress,
}: {
  item: ScheduleOccurrenceView;
  onPress?: () => void;
}) {
  const startLabel = item.isAllDay ? '全天' : formatTime(item.occurrenceStart, item.timezone);
  const isRecurring = item.recurrenceMode !== 'once';

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${formatRange(item)} ${item.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.indicator, item.isAllDay && styles.allDayIndicator]} />
      <View style={styles.timeColumn}>
        <Text numberOfLines={1} style={styles.startTime}>
          {startLabel}
        </Text>
        {!item.isAllDay && item.occurrenceEnd ? (
          <Text numberOfLines={1} style={styles.endTime}>
            至 {formatTime(item.occurrenceEnd, item.timezone)}
          </Text>
        ) : null}
      </View>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        {isRecurring ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>重复</Text>
          </View>
        ) : null}
        {item.locationName ? (
          <Text numberOfLines={1} style={styles.location}>
            {item.locationName}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  allDayIndicator: { backgroundColor: colors.accent },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  copy: { flex: 1, gap: 6, minWidth: 0 },
  endTime: { color: colors.mutedText, fontSize: 11, marginTop: 3 },
  indicator: {
    alignSelf: 'stretch',
    backgroundColor: colors.focus,
    borderRadius: 999,
    width: 4,
  },
  location: { color: colors.mutedText, fontSize: 13 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.995 }] },
  row: {
    alignItems: 'stretch',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    padding: 14,
  },
  startTime: { color: colors.text, fontSize: 15, fontWeight: '800' },
  timeColumn: { paddingTop: 1, width: 58 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 21 },
});
