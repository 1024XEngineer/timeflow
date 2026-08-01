import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import { Calendar, LocaleConfig, type DateData } from 'react-native-calendars';

import { BottomSheetFrame } from '@/shared/components/BottomSheetFrame';
import { colors } from '@/shared/theme';
import { dateKey } from '@/shared/utils/date';

import { datePickerSheetStyles as styles } from './DatePickerSheet.styles';

type DayMarking = {
  dotColor?: string;
  marked?: boolean;
  selected?: boolean;
  selectedColor?: string;
};

type MarkedDates = Record<string, DayMarking>;

LocaleConfig.locales.zh = {
  monthNames: [
    '一月',
    '二月',
    '三月',
    '四月',
    '五月',
    '六月',
    '七月',
    '八月',
    '九月',
    '十月',
    '十一月',
    '十二月',
  ],
  monthNamesShort: [
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ],
  dayNames: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  dayNamesShort: ['日', '一', '二', '三', '四', '五', '六'],
  today: '今天',
};
LocaleConfig.defaultLocale = 'zh';

const calendarTheme = {
  arrowColor: colors.deep,
  backgroundColor: colors.surface,
  calendarBackground: colors.surface,
  dayTextColor: colors.ink,
  dotColor: colors.coral,
  monthTextColor: colors.ink,
  selectedDayBackgroundColor: colors.deep,
  selectedDayTextColor: colors.surface,
  selectedDotColor: colors.surface,
  textDayFontSize: 14,
  textDayFontWeight: '600' as const,
  textDayHeaderFontSize: 12,
  textDayHeaderFontWeight: '700' as const,
  textMonthFontSize: 16,
  textMonthFontWeight: '800' as const,
  textSectionTitleColor: colors.sub,
  todayTextColor: colors.deep,
};

function parseDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

type DatePickerSheetProps = {
  markedDateKeys?: string[];
  onClose: () => void;
  onSelect: (date: Date) => void;
  selectedDate: Date;
  visible: boolean;
};

export function DatePickerSheet({
  markedDateKeys = [],
  onClose,
  onSelect,
  selectedDate,
  visible,
}: DatePickerSheetProps) {
  const selectedKey = dateKey(selectedDate);
  const markedDates = useMemo(() => {
    const next: MarkedDates = {};
    for (const key of markedDateKeys) {
      next[key] = { marked: true, dotColor: colors.coral };
    }
    next[selectedKey] = {
      ...(next[selectedKey] ?? {}),
      selected: true,
      selectedColor: colors.deep,
    };
    return next;
  }, [markedDateKeys, selectedKey]);

  const handleDayPress = (day: DateData) => {
    onSelect(parseDateKey(day.dateString));
    onClose();
  };

  return (
    <BottomSheetFrame
      closeAccessibilityLabel="关闭日期选择"
      eyebrow="CALENDAR"
      onClose={onClose}
      title="选择日期"
      visible={visible}
    >
      <Calendar
        current={selectedKey}
        enableSwipeMonths
        firstDay={1}
        markedDates={markedDates}
        markingType="dot"
        onDayPress={handleDayPress}
        style={styles.calendar}
        theme={calendarTheme}
      />
      <Pressable
        accessibilityLabel="回到今天"
        accessibilityRole="button"
        onPress={() => {
          onSelect(new Date());
          onClose();
        }}
        style={styles.todayButton}
      >
        <Text style={styles.todayButtonText}>回到今天</Text>
      </Pressable>
    </BottomSheetFrame>
  );
}
