import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../../../shared/ui/theme';
import type {
  LocationScheduleView,
  ScheduleCalendarReadService,
  ScheduleOccurrenceView,
} from '../application';
import { LocationScheduleDetailSheet } from './LocationScheduleDetailSheet';
import { LocationScheduleRow } from './LocationScheduleRow';
import { MonthCalendar } from './MonthCalendar';
import { ScheduleOccurrenceDetailSheet } from './ScheduleOccurrenceDetailSheet';
import { ScheduleOccurrenceRow } from './ScheduleOccurrenceRow';
import { useScheduleCalendar } from './useScheduleCalendar';

const SELECTED_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  day: 'numeric',
  month: 'long',
  weekday: 'long',
});

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
  const selectedLabel = SELECTED_DATE_FORMATTER.format(calendar.selectedDate);

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>我的日程</Text>
            <Text style={styles.title}>{selectedLabel}</Text>
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
            <View style={styles.agenda}>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionEyebrow}>当日安排</Text>
                  <Text style={styles.sectionTitle}>日程</Text>
                </View>
                <Text style={styles.sectionCount}>{calendar.selectedOccurrences.length} 项</Text>
              </View>

              {calendar.selectedOccurrences.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>这一天暂时没有日程</Text>
                  <Text style={styles.emptyCopy}>留一点时间给自己，或用语音助手添加安排。</Text>
                </View>
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
                <View style={styles.locationSection}>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.sectionEyebrow}>位置触发</Text>
                      <Text style={styles.sectionTitle}>地点提醒</Text>
                    </View>
                    <Text style={styles.sectionCount}>{calendar.locationSchedules.length} 项</Text>
                  </View>
                  {calendar.locationSchedules.map((item) => (
                    <LocationScheduleRow
                      item={item}
                      key={item.scheduleId}
                      onPress={() => setSelectedLocation(item)}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>

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
  agenda: { paddingHorizontal: spacing.md, paddingTop: spacing.xl },
  center: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: spacing.md,
    justifyContent: 'center',
    marginHorizontal: spacing.md,
    marginTop: spacing.xl,
    minHeight: 180,
    padding: spacing.lg,
  },
  content: { alignSelf: 'center', maxWidth: 720, width: '100%' },
  empty: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  emptyCopy: {
    color: colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  error: { color: colors.error, fontSize: 15, textAlign: 'center' },
  eyebrow: { color: colors.mutedText, fontSize: 13, fontWeight: '700' },
  header: {
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  locationSection: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
  },
  retry: {
    backgroundColor: colors.text,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.onPrimary, fontWeight: '700' },
  screen: { backgroundColor: colors.background, flex: 1 },
  scrollContent: { paddingBottom: spacing.xxl * 3 },
  sectionCount: { color: colors.mutedText, fontSize: 12, fontWeight: '600' },
  sectionEyebrow: { color: colors.mutedText, fontSize: 12, fontWeight: '600', marginBottom: 3 },
  sectionHeader: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 14,
  },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  stateText: { color: colors.mutedText },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', lineHeight: 34, marginTop: 4 },
});
