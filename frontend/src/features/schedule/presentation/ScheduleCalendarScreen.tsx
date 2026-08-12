import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ScheduleClientService } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import { MonthCalendar } from './MonthCalendar';
import { ScheduleOccurrenceRow } from './ScheduleOccurrenceRow';
import { useScheduleCalendar } from './useScheduleCalendar';

export function ScheduleCalendarScreen({
  service,
  accountId,
  timezone,
}: {
  service: ScheduleClientService;
  accountId: string;
  timezone: string;
}) {
  const calendar = useScheduleCalendar(service, accountId, timezone);
  const selectedLabel = `${calendar.selectedDate.getMonth() + 1}月${calendar.selectedDate.getDate()}日`;
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>我的日程</Text>
          <Text style={styles.title}>{selectedLabel}</Text>
        </View>
        <Text style={styles.account}>{accountId}</Text>
      </View>
      <MonthCalendar
        month={calendar.visibleMonth}
        selectedDate={calendar.selectedDate}
        today={new Date()}
        occurrencesByDate={calendar.occurrencesByDate}
        onSelectDate={calendar.selectDate}
        onChangeMonth={calendar.changeMonth}
      />
      {calendar.loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.focus} />
          <Text style={styles.stateText}>正在加载日程</Text>
        </View>
      ) : null}
      {calendar.error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{calendar.error}</Text>
          <Pressable accessibilityRole="button" onPress={calendar.retry} style={styles.retry}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : null}
      {!calendar.loading && !calendar.error ? (
        <ScrollView contentContainerStyle={styles.list}>
          {calendar.selectedOccurrences.length === 0 ? (
            <Text style={styles.empty}>这一天暂无日程</Text>
          ) : (
            calendar.selectedOccurrences.map((item) => (
              <ScheduleOccurrenceRow
                item={item}
                key={`${item.scheduleId}-${item.occurrenceStart}`}
              />
            ))
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  account: { color: colors.mutedText, fontSize: 12 },
  center: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  empty: { color: colors.mutedText, fontSize: 15, padding: spacing.xl, textAlign: 'center' },
  error: { color: colors.error, fontSize: 15, textAlign: 'center' },
  eyebrow: { color: colors.mutedText, fontSize: 13, fontWeight: '600' },
  header: {
    alignItems: 'flex-end',
    backgroundColor: colors.background,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  list: { paddingBottom: spacing.xl },
  retry: {
    backgroundColor: colors.text,
    borderRadius: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.onPrimary, fontWeight: '700' },
  screen: { backgroundColor: colors.background, flex: 1 },
  stateText: { color: colors.mutedText },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: 3 },
});
