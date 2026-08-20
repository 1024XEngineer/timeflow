import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ScheduleOccurrenceView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import { formatRange, formatTime, scheduleCategoryLabel } from './scheduleDisplay';

const CARD_HEIGHT = 88;
const ROW_FOLLOW_GAP = 10;

export function ScheduleOccurrenceRow({
  item,
  isLast = true,
  onPress,
}: {
  item: ScheduleOccurrenceView;
  isLast?: boolean;
  onPress?: () => void;
}) {
  const startLabel = item.isAllDay ? '全天' : formatTime(item.occurrenceStart, item.timezone);
  const endLabel =
    !item.isAllDay && item.occurrenceEnd ? formatTime(item.occurrenceEnd, item.timezone) : null;
  const isRecurring = item.recurrenceMode !== 'once';
  const categoryLabel = scheduleCategoryLabel(item.category);
  const hasMeta = Boolean(item.locationName) || isRecurring || Boolean(categoryLabel);

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${formatRange(item)} ${item.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !isLast && styles.rowFollow, pressed && styles.pressed]}
      testID="schedule-occurrence-row"
    >
      <View style={styles.timeColumn} testID="schedule-occurrence-time">
        <Text numberOfLines={1} style={styles.startTime}>
          {startLabel}
        </Text>
        {endLabel ? (
          <Text numberOfLines={1} style={styles.endTime}>
            {endLabel}
          </Text>
        ) : null}
      </View>

      <View accessible={false} style={styles.rail}>
        <View
          style={[styles.railLine, isLast ? styles.railLineLast : styles.railLineFollow]}
          testID="schedule-occurrence-rail-line"
        />
        <View
          style={[styles.railDot, item.isAllDay && styles.railDotAllDay]}
          testID="schedule-occurrence-indicator"
        />
      </View>

      <View style={styles.card} testID="schedule-occurrence-card">
        <Text style={styles.title} numberOfLines={2}>
          {item.title}
        </Text>
        {hasMeta ? (
          <View style={styles.meta}>
            {item.locationName ? (
              <Text numberOfLines={1} style={styles.metaText}>
                {item.locationName}
              </Text>
            ) : null}
            {categoryLabel ? (
              <Text numberOfLines={1} style={styles.repeat}>
                {categoryLabel}
              </Text>
            ) : null}
            {isRecurring ? <Text style={styles.repeat}>重复</Text> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 4,
    height: CARD_HEIGHT,
    justifyContent: 'center',
    minWidth: 0,
    overflow: 'hidden',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  endTime: {
    color: colors.mutedText,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
    letterSpacing: 0.2,
    lineHeight: 16,
    marginTop: 2,
  },
  meta: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: spacing.sm,
    minWidth: 0,
  },
  metaText: {
    color: colors.mutedText,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 16,
    minWidth: 0,
  },
  pressed: { opacity: 0.72, transform: [{ scale: 0.995 }] },
  rail: {
    alignItems: 'center',
    alignSelf: 'stretch',
    overflow: 'visible',
    width: 14,
  },
  railDot: {
    backgroundColor: colors.focus,
    borderColor: colors.background,
    borderRadius: 999,
    borderWidth: 3,
    height: 10,
    marginTop: 8,
    width: 10,
    zIndex: 1,
  },
  railDotAllDay: { backgroundColor: colors.text },
  railLine: {
    backgroundColor: colors.focus,
    left: 6,
    position: 'absolute',
    top: 12,
    width: 2,
  },
  railLineFollow: { bottom: -ROW_FOLLOW_GAP },
  railLineLast: { bottom: 18 },
  repeat: {
    color: colors.mutedText,
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  row: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 12,
    overflow: 'visible',
  },
  rowFollow: { paddingBottom: ROW_FOLLOW_GAP },
  startTime: {
    color: colors.text,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 0.2,
    lineHeight: 20,
  },
  timeColumn: { paddingTop: 6, width: 52 },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    includeFontPadding: false,
    lineHeight: 22,
  },
});
