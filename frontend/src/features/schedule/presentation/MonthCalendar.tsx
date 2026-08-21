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
    <View style={styles.container} testID="month-calendar">
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
          // Fabric 新架构下，样式数组里混入 false 会让前一项的 borderRadius 在
          // 合并时丢失：实测 `[dateBubble, false, selectedBubble]` 把选中气泡画成
          // 方块（今天气泡 `[dateBubble, todayBubble, ...]` 是圆）。先滤掉假值，
          // 保证数组里全是真实样式对象。
          const bubbleStyle = [
            styles.dateBubble,
            todayMatch && styles.todayBubble,
            selected && styles.selectedBubble,
          ].filter(Boolean);
          const textStyle = [
            styles.dayText,
            !inMonth && styles.muted,
            todayMatch && styles.todayText,
            selected && styles.selectedText,
          ].filter(Boolean);
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
              <View style={bubbleStyle}>
                <Text style={textStyle}>{day.getDate()}</Text>
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
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    maxWidth: 520,
    padding: spacing.md,
    width: '92%',
  },
  // backgroundColor 必须常驻：Fabric 新架构下 View 从"无背景"变成"有背景"时，
  // 新建的背景 drawable 不会带 borderRadius，圆角直接丢（实测非今天的选中气泡
  // 因此画成方块；今天气泡因始终有 accent 背景所以是圆）。白色背景在 surface
  // 上不可见，overflow:hidden 再兜底把内容裁剪成圆。
  dateBubble: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    overflow: 'hidden',
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
  // 注意：不能加 borderWidth/borderColor —— Android 上 View 同时带 border 时
  // borderRadius 圆角会被画成方块（今天气泡无 border 是正圆，带 border 的选中
  // 气泡实测变方）。选中态只需要背景色即可。
  selectedBubble: { backgroundColor: colors.text },
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
