import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ScheduleOccurrenceView } from '../application';
import { colors, spacing } from '../../../shared/ui/theme';
import {
  DetailMeta,
  DetailSection,
  formatReminderDetail,
  normalizeDetailText,
  ScheduleDetailSheet,
} from './ScheduleDetailSheet';
import { dateKeyInTimezone, formatTime } from './scheduleDisplay';

export function ScheduleOccurrenceDetailSheet({
  occurrence,
  onClose,
}: {
  occurrence: ScheduleOccurrenceView | null;
  onClose: () => void;
}) {
  const [previousOccurrence, setPreviousOccurrence] = useState<ScheduleOccurrenceView | null>(
    occurrence,
  );
  const [lastOccurrence, setLastOccurrence] = useState<ScheduleOccurrenceView | null>(occurrence);
  if (occurrence !== previousOccurrence) {
    setPreviousOccurrence(occurrence);
    if (occurrence) setLastOccurrence(occurrence);
  }
  const detailOccurrence = occurrence ?? lastOccurrence;
  if (!detailOccurrence) return null;

  const date = formatOccurrenceDate(detailOccurrence.occurrenceStart, detailOccurrence.timezone);
  const location = normalizeDetailText(detailOccurrence.locationName);
  const reminder = formatReminderDetail(
    detailOccurrence.reminderType,
    detailOccurrence.reminderStrength,
  );
  const crossesDay = isCrossDay(
    detailOccurrence.occurrenceStart,
    detailOccurrence.occurrenceEnd,
    detailOccurrence.timezone,
  );
  const badges = [
    detailOccurrence.scheduleCategory === 'time' ? '时间日程' : '地点日程',
    detailOccurrence.recurrenceMode === 'recurring' ? '周期日程' : '一次性',
    ...(detailOccurrence.isAllDay ? ['全天'] : []),
  ];

  return (
    <ScheduleDetailSheet
      badges={badges}
      onClose={onClose}
      title={detailOccurrence.title}
      visible={occurrence !== null}
    >
      <View style={styles.timeCard}>
        <View style={styles.timeHeader}>
          <View accessible={false} style={styles.timeIcon}>
            <Text style={styles.timeIconText}>◷</Text>
          </View>
          <Text style={styles.timeLabel}>时间</Text>
        </View>
        {date ? (
          <View style={styles.dateRow}>
            <Text style={styles.date}>{date.value}</Text>
            <Text style={styles.weekday}>{date.weekday}</Text>
          </View>
        ) : null}
        <View style={styles.timeDivider} />
        {detailOccurrence.isAllDay ? (
          <Text style={styles.allDay}>全天</Text>
        ) : (
          <View style={styles.timeRange}>
            <TimePoint
              date={
                crossesDay
                  ? formatShortDate(detailOccurrence.occurrenceStart, detailOccurrence.timezone)
                  : undefined
              }
              label="开始"
              value={formatTime(detailOccurrence.occurrenceStart, detailOccurrence.timezone)}
            />
            {detailOccurrence.occurrenceEnd ? (
              <TimePoint
                date={
                  crossesDay
                    ? formatShortDate(detailOccurrence.occurrenceEnd, detailOccurrence.timezone)
                    : undefined
                }
                label="结束"
                value={formatTime(detailOccurrence.occurrenceEnd, detailOccurrence.timezone)}
              />
            ) : null}
          </View>
        )}
      </View>
      {location ? <DetailSection icon="📍" label="地点" primary={location} /> : null}
      {reminder ? (
        <DetailSection
          icon="🔔"
          label="提醒"
          primary={reminder.primary}
          secondary={reminder.secondary}
        />
      ) : null}
      <DetailMeta icon="◎">时区 · {detailOccurrence.timezone}</DetailMeta>
    </ScheduleDetailSheet>
  );
}

function TimePoint({ date, label, value }: { date?: string; label: string; value: string }) {
  return (
    <View style={styles.timePoint}>
      <Text style={styles.timePointLabel}>{label}</Text>
      {date ? <Text style={styles.timePointDate}>{date}</Text> : null}
      <Text style={styles.timePointValue}>{value}</Text>
    </View>
  );
}

function isCrossDay(start: string | null, end: string | null, timezone: string): boolean {
  if (!start || !end) return false;
  const startDate = dateKeyInTimezone(start, timezone);
  const endDate = dateKeyInTimezone(end, timezone);
  return startDate !== null && endDate !== null && startDate !== endDate;
}

function formatShortDate(instant: string | null, timezone: string): string | undefined {
  if (!instant) return undefined;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat('zh-CN', {
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(parsed);
}

function formatOccurrenceDate(instant: string | null, timezone: string) {
  if (!instant) return null;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    value: new Intl.DateTimeFormat('zh-CN', {
      day: 'numeric',
      month: 'long',
      timeZone: timezone,
      year: 'numeric',
    }).format(parsed),
    weekday: new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      weekday: 'long',
    }).format(parsed),
  };
}

const styles = StyleSheet.create({
  allDay: { color: colors.text, fontSize: 24, fontWeight: '800', paddingTop: spacing.xs },
  date: { color: colors.text, fontSize: 20, fontWeight: '800', lineHeight: 28 },
  dateRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  timeCard: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  timeDivider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginVertical: 14,
  },
  timeHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  timeIcon: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 10,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  timeIconText: { color: colors.text, fontSize: 17, fontWeight: '700' },
  timeLabel: { color: colors.mutedText, fontSize: 12, fontWeight: '700' },
  timePoint: { flex: 1, minWidth: 96 },
  timePointDate: { color: colors.mutedText, fontSize: 13, fontWeight: '600', marginTop: 5 },
  timePointLabel: { color: colors.mutedText, fontSize: 12, fontWeight: '700' },
  timePointValue: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 2 },
  timeRange: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  weekday: { color: colors.mutedText, fontSize: 14, fontWeight: '600' },
});
