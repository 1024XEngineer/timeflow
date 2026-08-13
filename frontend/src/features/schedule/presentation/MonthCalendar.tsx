import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ScheduleOccurrenceView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import { addDays, dateKey, startOfMonth, WEEKDAY_LABELS } from './scheduleDisplay';

export function MonthCalendar({
  month,
  selectedDate,
  today,
  occurrencesByDate,
  onSelectDate,
  onChangeMonth,
}: {
  month: Date;
  selectedDate: Date;
  today: Date;
  occurrencesByDate: ReadonlyMap<string, readonly ScheduleOccurrenceView[]>;
  onSelectDate: (date: Date) => void;
  onChangeMonth: (offset: number) => void;
}) {
  const first = startOfMonth(month);
  const offset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => addDays(first, index - offset));
  const selectedKey = dateKey(selectedDate);
  const todayKey = dateKey(today);
  return (
    <View style={styles.container}>
      <View style={styles.monthHeader}>
        <Pressable
          accessibilityLabel="上个月"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => onChangeMonth(-1)}
          style={styles.nav}
        >
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{`${month.getFullYear()}年${month.getMonth() + 1}月`}</Text>
        <Pressable
          accessibilityLabel="下个月"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => onChangeMonth(1)}
          style={styles.nav}
        >
          <Text style={styles.navText}>›</Text>
        </Pressable>
      </View>
      <View style={styles.weekdays}>
        {WEEKDAY_LABELS.map((label) => (
          <Text key={label} style={styles.weekday}>
            {label}
          </Text>
        ))}
      </View>
      <View style={styles.grid}>
        {days.map((day) => {
          const key = dateKey(day);
          const inMonth = day.getMonth() === month.getMonth();
          const selected = key === selectedKey;
          const todayMatch = key === todayKey;
          const hasItems = (occurrencesByDate.get(key)?.length ?? 0) > 0;
          return (
            <Pressable
              accessibilityLabel={`${day.getMonth() + 1}月${day.getDate()}日`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              disabled={!inMonth}
              key={key}
              onPress={() => onSelectDate(day)}
              style={({ pressed }) => [styles.day, pressed && inMonth && styles.dayPressed]}
            >
              <View
                style={[
                  styles.dateBubble,
                  todayMatch && styles.todayBubble,
                  selected && styles.selectedBubble,
                ]}
              >
                <Text
                  style={[
                    styles.dayText,
                    !inMonth && styles.muted,
                    todayMatch && styles.todayText,
                    selected && styles.selectedText,
                  ]}
                >
                  {day.getDate()}
                </Text>
              </View>
              {hasItems ? (
                <View
                  style={[
                    styles.marker,
                    !inMonth && styles.hiddenMarker,
                    selected && styles.selectedMarker,
                  ]}
                />
              ) : (
                <View style={styles.markerPlaceholder} />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    marginHorizontal: spacing.md,
    padding: spacing.md,
  },
  dateBubble: {
    alignItems: 'center',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  day: { alignItems: 'center', height: 44, justifyContent: 'center', width: '14.285%' },
  dayPressed: { opacity: 0.6 },
  dayText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  hiddenMarker: { opacity: 0 },
  marker: { backgroundColor: colors.focus, borderRadius: 999, height: 4, marginTop: 2, width: 4 },
  markerPlaceholder: { height: 4, marginTop: 2, width: 4 },
  monthHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.md,
  },
  monthTitle: { color: colors.text, fontSize: 19, fontWeight: '800' },
  muted: { color: colors.border },
  nav: {
    alignItems: 'center',
    backgroundColor: colors.input,
    borderRadius: 12,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  navText: { color: colors.text, fontSize: 25, fontWeight: '500', lineHeight: 27 },
  selectedBubble: { backgroundColor: colors.text, borderColor: colors.text, borderWidth: 1 },
  selectedMarker: { backgroundColor: colors.text },
  selectedText: { color: colors.onPrimary },
  todayBubble: { backgroundColor: colors.accent },
  todayText: { fontWeight: '800' },
  weekdays: { flexDirection: 'row', paddingBottom: spacing.sm },
  weekday: {
    color: colors.mutedText,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    width: '14.285%',
  },
});
