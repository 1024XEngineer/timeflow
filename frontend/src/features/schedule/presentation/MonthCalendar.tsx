import { Pressable, StyleSheet, Text, View } from 'react-native';

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
  occurrencesByDate: ReadonlyMap<string, readonly unknown[]>;
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
          onPress={() => onChangeMonth(-1)}
          style={styles.nav}
        >
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <Text style={styles.monthTitle}>{`${month.getFullYear()}年${month.getMonth() + 1}月`}</Text>
        <Pressable
          accessibilityLabel="下个月"
          accessibilityRole="button"
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
              disabled={!inMonth}
              key={key}
              onPress={() => onSelectDate(day)}
              style={[styles.day, selected && styles.selected, todayMatch && styles.today]}
            >
              <Text
                style={[styles.dayText, !inMonth && styles.muted, selected && styles.selectedText]}
              >
                {day.getDate()}
              </Text>
              {hasItems ? (
                <View style={[styles.marker, selected && styles.selectedMarker]} />
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
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  day: { alignItems: 'center', aspectRatio: 1, justifyContent: 'center', width: '14.285%' },
  dayText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  marker: { backgroundColor: colors.focus, borderRadius: 3, height: 5, marginTop: 3, width: 5 },
  markerPlaceholder: { height: 5, marginTop: 3, width: 5 },
  monthHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  monthTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  muted: { color: colors.mutedText },
  nav: { alignItems: 'center', height: 36, justifyContent: 'center', width: 42 },
  navText: { color: colors.text, fontSize: 28, fontWeight: '400', lineHeight: 30 },
  selected: { backgroundColor: colors.text, borderRadius: 8 },
  selectedMarker: { backgroundColor: colors.accent },
  selectedText: { color: colors.onPrimary },
  today: { borderColor: colors.accent, borderRadius: 8, borderWidth: 1 },
  weekdays: { flexDirection: 'row', paddingBottom: spacing.xs },
  weekday: { color: colors.mutedText, fontSize: 12, textAlign: 'center', width: '14.285%' },
});
