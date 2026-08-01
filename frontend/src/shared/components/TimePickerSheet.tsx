import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { BottomSheetFrame } from '@/shared/components/BottomSheetFrame';

import { timePickerSheetStyles as styles } from './TimePickerSheet.styles';

const HOURS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));
const ITEM_HEIGHT = 44;

type TimePickerSheetProps = {
  onClose: () => void;
  onSelect: (time: string) => void;
  selectedTime: Date;
  visible: boolean;
};

function TimeWheelColumn({
  accessibilityUnit,
  label,
  listRef,
  onSelect,
  selected,
  values,
}: {
  accessibilityUnit: string;
  label: string;
  listRef: RefObject<ScrollView | null>;
  onSelect: (value: string) => void;
  selected: string;
  values: string[];
}) {
  return (
    <View style={styles.column}>
      <Text style={styles.columnLabel}>{label}</Text>
      <ScrollView ref={listRef} showsVerticalScrollIndicator={false} style={styles.list}>
        {values.map((value) => {
          const isSelected = value === selected;
          return (
            <Pressable
              key={value}
              accessibilityLabel={`${Number(value)} ${accessibilityUnit}`}
              onPress={() => onSelect(value)}
              style={[styles.item, isSelected && styles.itemSelected]}
            >
              <Text style={[styles.itemText, isSelected && styles.itemTextSelected]}>{value}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function TimePickerSheet({
  onClose,
  onSelect,
  selectedTime,
  visible,
}: TimePickerSheetProps) {
  const [hour, setHour] = useState(() => String(selectedTime.getHours()).padStart(2, '0'));
  const [minute, setMinute] = useState(() => String(selectedTime.getMinutes()).padStart(2, '0'));
  const hourListRef = useRef<ScrollView>(null);
  const minuteListRef = useRef<ScrollView>(null);
  const selectedTimeMs = selectedTime.getTime();

  useEffect(() => {
    if (!visible) return;
    const nextHour = String(new Date(selectedTimeMs).getHours()).padStart(2, '0');
    const nextMinute = String(new Date(selectedTimeMs).getMinutes()).padStart(2, '0');
    // 打开或外部时间变化时同步滚轮；属受控 sheet 的合法同步。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync picker when sheet opens
    setHour(nextHour);
    setMinute(nextMinute);
    const frame = requestAnimationFrame(() => {
      hourListRef.current?.scrollTo({ y: Number(nextHour) * ITEM_HEIGHT, animated: false });
      minuteListRef.current?.scrollTo({ y: Number(nextMinute) * ITEM_HEIGHT, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedTimeMs, visible]);

  const preview = useMemo(() => `${hour}:${minute}`, [hour, minute]);

  const confirm = () => {
    onSelect(`${hour}:${minute}`);
    onClose();
  };

  return (
    <BottomSheetFrame
      closeAccessibilityLabel="关闭时间选择"
      onClose={onClose}
      showClose={false}
      title="选择时间"
      visible={visible}
    >
      <Text style={styles.preview}>{preview}</Text>
      <View style={styles.columns}>
        <TimeWheelColumn
          accessibilityUnit="时"
          label="时"
          listRef={hourListRef}
          onSelect={setHour}
          selected={hour}
          values={HOURS}
        />
        <TimeWheelColumn
          accessibilityUnit="分"
          label="分"
          listRef={minuteListRef}
          onSelect={setMinute}
          selected={minute}
          values={MINUTES}
        />
      </View>
      <Pressable
        accessibilityLabel="确认时间"
        accessibilityRole="button"
        onPress={confirm}
        style={styles.confirm}
      >
        <Text style={styles.confirmText}>确认</Text>
      </Pressable>
    </BottomSheetFrame>
  );
}
