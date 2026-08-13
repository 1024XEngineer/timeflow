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
import { formatTime } from './scheduleDisplay';

export function ScheduleOccurrenceDetailSheet({
  occurrence,
  onClose,
}: {
  occurrence: ScheduleOccurrenceView | null;
  onClose: () => void;
}) {
  if (!occurrence) {
    return null;
  }

  const date = formatOccurrenceDate(occurrence.occurrenceStart, occurrence.timezone);
  const location = normalizeDetailText(occurrence.locationName);
  const reminder = formatReminderDetail(occurrence.reminderType, occurrence.reminderStrength);
  const badges = [
    occurrence.scheduleCategory === 'time' ? '时间日程' : '地点日程',
    occurrence.recurrenceMode === 'recurring' ? '周期日程' : '一次性',
    ...(occurrence.isAllDay ? ['全天'] : []),
  ];

  return (
    <ScheduleDetailSheet badges={badges} onClose={onClose} title={occurrence.title}>
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
        {occurrence.isAllDay ? (
          <Text style={styles.allDay}>全天</Text>
        ) : (
          <View style={styles.timeRange}>
            <TimePoint
              label="开始"
              value={formatTime(occurrence.occurrenceStart, occurrence.timezone)}
            />
            {occurrence.occurrenceEnd ? (
              <TimePoint
                label="结束"
                value={formatTime(occurrence.occurrenceEnd, occurrence.timezone)}
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
      <DetailMeta icon="◎">时区 · {occurrence.timezone}</DetailMeta>
    </ScheduleDetailSheet>
  );
}

function TimePoint({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.timePoint}>
      <Text style={styles.timePointLabel}>{label}</Text>
      <Text style={styles.timePointValue}>{value}</Text>
    </View>
  );
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
  timePointLabel: { color: colors.mutedText, fontSize: 12, fontWeight: '700' },
  timePointValue: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 2 },
  timeRange: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  weekday: { color: colors.mutedText, fontSize: 14, fontWeight: '600' },
});
