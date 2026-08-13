import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import type {
  LocationScheduleView,
  ScheduleCalendarReadService,
  ScheduleOccurrenceView,
} from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import { LocationScheduleDetailSheet } from './LocationScheduleDetailSheet';
import { LocationScheduleRow } from './LocationScheduleRow';
import { MonthCalendar } from './MonthCalendar';
import { ScheduleOccurrenceRow } from './ScheduleOccurrenceRow';
import { ScheduleOccurrenceDetailSheet } from './ScheduleOccurrenceDetailSheet';
import { useScheduleCalendar } from './useScheduleCalendar';

export function ScheduleCalendarScreen({
  service,
  accountId,
  timezone,
  refreshSignal,
}: {
  service: ScheduleCalendarReadService;
  accountId: string;
  timezone: string;
  /** 外部触发刷新用（比如语音写完一条日程）；变化即重取，不用管具体数值。 */
  refreshSignal?: number;
}) {
  const calendar = useScheduleCalendar(service, accountId, timezone, undefined, refreshSignal);
  const [selectedOccurrence, setSelectedOccurrence] = useState<ScheduleOccurrenceView | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<LocationScheduleView | null>(null);
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
                onPress={() => setSelectedOccurrence(item)}
              />
            ))
          )}
          {calendar.locationSchedules.length > 0 ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>地点提醒</Text>
              </View>
              {calendar.locationSchedules.map((item) => (
                <LocationScheduleRow
                  item={item}
                  key={item.scheduleId}
                  onPress={() => setSelectedLocation(item)}
                />
              ))}
            </>
          ) : null}
        </ScrollView>
      ) : null}
      <ScheduleOccurrenceDetailSheet
        occurrence={selectedOccurrence}
        onClose={() => setSelectedOccurrence(null)}
      />
      <LocationScheduleDetailSheet
        schedule={selectedLocation}
        onClose={() => setSelectedLocation(null)}
      />
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
  sectionHeader: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    paddingTop: spacing.lg,
  },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  stateText: { color: colors.mutedText },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: 3 },
});
