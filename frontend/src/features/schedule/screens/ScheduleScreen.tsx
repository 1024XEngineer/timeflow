import { useMemo, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { DatePickerSheet } from '@/shared/components/DatePickerSheet';
import type { Schedule } from '@/contracts';
import { useCurrentDate } from '@/shared/hooks/useCurrentDate';
import { colors } from '@/shared/theme';
import { startOfMonth } from '@/shared/utils/date';

import { MonthView } from '../calendar/MonthView';
import { buildScheduleIndex } from '../calendar/scheduleIndex';
import { ScheduleDetailSheet } from '../detail/ScheduleDetailSheet';
import { scheduleScreenStyles as styles } from './scheduleScreen.styles';

export function ScheduleScreen({
  canMutate = true,
  onCreate,
  onDeleteSchedule,
  onEditSchedule,
  onToggleSchedule,
  scheduleItems,
}: {
  canMutate?: boolean;
  onCreate: () => void;
  onDeleteSchedule: (item: Schedule) => void;
  onEditSchedule: (item: Schedule) => void;
  onToggleSchedule?: (item: Schedule) => void;
  scheduleItems: Schedule[];
}) {
  const now = useCurrentDate();
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(now));
  const [selectedDate, setSelectedDate] = useState(() => now);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Derive the selected entity from the cache. When a push removes it, the
  // detail sheet naturally closes without mutating state during render.
  const selectedSchedule = selectedScheduleId
    ? scheduleItems.find((item) => item.id === selectedScheduleId)
    : undefined;
  const scheduleIndex = useMemo(() => buildScheduleIndex(scheduleItems), [scheduleItems]);

  const selectDate = (date: Date) => {
    setSelectedDate(date);
    setVisibleMonth(startOfMonth(date));
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="选择日期"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => setDatePickerOpen(true)}
          style={styles.headerButton}
        >
          <Text style={styles.headerEyebrow}>
            {visibleMonth.getFullYear()}年{visibleMonth.getMonth() + 1}月
          </Text>
          <View style={styles.headerTitleRow}>
            <Text style={styles.headerTitle}>{visibleMonth.getMonth() + 1}月</Text>
            <ChevronDown color={colors.sub} size={18} strokeWidth={2.2} />
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel="添加日程"
          accessibilityRole="button"
          hitSlop={6}
          onPress={onCreate}
          accessibilityState={{ disabled: !canMutate }}
          disabled={!canMutate}
          style={[styles.addButton, !canMutate && styles.addButtonDisabled]}
        >
          <Plus color={colors.deep} size={20} strokeWidth={2.2} />
        </Pressable>
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>
        <MonthView
          now={now}
          onToggleSchedule={canMutate ? onToggleSchedule : undefined}
          onMonthChange={setVisibleMonth}
          onOpenSchedule={setSelectedScheduleId}
          onSelectDate={setSelectedDate}
          selectedDate={selectedDate}
          scheduleIndex={scheduleIndex}
          visibleMonth={visibleMonth}
        />
      </View>
      <DatePickerSheet
        markedDateKeys={scheduleIndex.markedDateKeys}
        onClose={() => setDatePickerOpen(false)}
        onSelect={selectDate}
        selectedDate={selectedDate}
        visible={datePickerOpen}
      />
      <ScheduleDetailSheet
        schedule={selectedSchedule ?? null}
        onDelete={
          canMutate && selectedSchedule && selectedSchedule.status !== 'deleted'
            ? () => onDeleteSchedule(selectedSchedule)
            : undefined
        }
        onEdit={
          canMutate && selectedSchedule && selectedSchedule.status !== 'deleted'
            ? () => onEditSchedule(selectedSchedule)
            : undefined
        }
        onToggle={
          canMutate && selectedSchedule && selectedSchedule.status !== 'deleted' && onToggleSchedule
            ? () => onToggleSchedule(selectedSchedule)
            : undefined
        }
        onClose={() => setSelectedScheduleId(null)}
        onOpenDay={(date) => {
          selectDate(date);
        }}
      />
    </View>
  );
}
