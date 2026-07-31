import { Check } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { colors } from '@/shared/theme';
import type { Schedule } from '@/contracts';
import { dateKey, formatMonthDay, WEEKDAY_LABELS } from '@/shared/utils/date';

import { ScheduleRow } from './ScheduleRow';
import type { ScheduleIndex } from './scheduleIndex';
import { schedulesOnDate } from './scheduleIndex';
import { monthStyles as styles } from './MonthView.styles';

export function MonthView({
  now,
  selectedDate,
  scheduleIndex,
  visibleMonth,
  onMonthChange,
  onOpenSchedule,
  onSelectDate,
  onToggleSchedule,
}: {
  now: Date;
  selectedDate: Date;
  scheduleIndex: ScheduleIndex;
  onMonthChange: (month: Date) => void;
  onOpenSchedule: (scheduleId: string) => void;
  onSelectDate: (date: Date) => void;
  onToggleSchedule?: (schedule: Schedule) => void;
  visibleMonth: Date;
}) {
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = Array.from(
    { length: 42 },
    (_, index) => new Date(year, month, index - firstDayOffset + 1),
  );
  const selectedKey = dateKey(selectedDate);
  const todayKey = dateKey(now);
  const selectedItems = schedulesOnDate(scheduleIndex, selectedDate);
  const dateItems = scheduleIndex.byDateKey;

  return (
    <ScrollView contentContainerStyle={styles.monthContent} showsVerticalScrollIndicator={false}>
      <View style={styles.monthCard}>
        <View style={styles.monthHeader}>
          <Pressable
            accessibilityLabel="上个月"
            accessibilityRole="button"
            onPress={() => onMonthChange(new Date(year, month - 1, 1))}
            style={styles.monthNavButton}
          >
            <Text style={styles.monthNavText}>上月</Text>
          </Pressable>
          <View>
            <Text style={styles.monthYear}>{year}</Text>
            <Text style={styles.monthTitle}>{month + 1}月</Text>
          </View>
          <Pressable
            accessibilityLabel="下个月"
            accessibilityRole="button"
            onPress={() => onMonthChange(new Date(year, month + 1, 1))}
            style={styles.monthNavButton}
          >
            <Text style={styles.monthNavText}>下月</Text>
          </Pressable>
        </View>
        <View style={styles.weekdayRow}>
          {WEEKDAY_LABELS.map((day) => (
            <Text key={day} style={styles.weekday}>
              {day}
            </Text>
          ))}
        </View>
        <View style={styles.monthGrid}>
          {Array.from({ length: 6 }, (_, rowIndex) => (
            <View key={rowIndex} style={styles.monthWeekRow}>
              {days.slice(rowIndex * 7, rowIndex * 7 + 7).map((day) => {
                const inMonth = day.getMonth() === month;
                const key = dateKey(day);
                const active = key === todayKey;
                const selected = key === selectedKey;
                const dayItems = dateItems.get(key) ?? [];
                const hasCompletedMarker =
                  inMonth &&
                  dayItems.length > 0 &&
                  dayItems.every((item) => item.status === 'done');
                const hasRegularMarker =
                  inMonth && dayItems.some((item) => item.status === 'scheduled');
                return (
                  <Pressable
                    accessibilityLabel={`${day.getMonth() + 1}月${day.getDate()}日`}
                    accessibilityRole="button"
                    disabled={!inMonth}
                    key={key}
                    onPress={() => onSelectDate(day)}
                    style={[
                      styles.monthDay,
                      active && styles.monthDayActive,
                      selected && !active && styles.monthDaySelected,
                      !inMonth && styles.monthDayMuted,
                    ]}
                  >
                    <Text
                      style={[
                        styles.monthDayText,
                        active && styles.monthDayTextActive,
                        selected && !active && styles.monthDayTextSelected,
                        !inMonth && styles.monthDayTextMuted,
                      ]}
                    >
                      {day.getDate()}
                    </Text>
                    {(hasCompletedMarker || hasRegularMarker) && (
                      <View
                        style={[
                          styles.monthDot,
                          active && styles.monthDayActiveDot,
                          hasCompletedMarker && styles.monthCompletedMarker,
                        ]}
                      >
                        {hasCompletedMarker && (
                          <Check
                            color={active ? colors.deep : colors.surface}
                            size={7}
                            strokeWidth={3}
                          />
                        )}
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </View>
      <View style={styles.monthSelectedHeading}>
        <Text style={styles.monthSelectedTitle}>{formatMonthDay(selectedDate)}</Text>
      </View>
      {selectedItems.length > 0 ? (
        selectedItems.map((item, index) => (
          <ScheduleRow
            compact
            item={item}
            key={item.id}
            onPress={() => onOpenSchedule(item.id)}
            onToggle={onToggleSchedule ? () => onToggleSchedule(item) : undefined}
            showConnector={index < selectedItems.length - 1}
          />
        ))
      ) : (
        <Text style={styles.scheduleEmpty}>这一天暂无详细安排</Text>
      )}
    </ScrollView>
  );
}
