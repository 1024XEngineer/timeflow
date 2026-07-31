import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { DatePickerSheet } from '@/shared/components/DatePickerSheet';
import { TimePickerSheet } from '@/shared/components/TimePickerSheet';

import { createSheetStyles as styles } from './createSheet.styles';
import { formatDateValue, parsePickerValue, type PickerMode } from './datetime';

/** 统一日期/时间字段：日期走 DatePickerSheet，时间走 TimePickerSheet。 */
export function DateTimeField({
  accessibilityLabel,
  mode,
  onChange,
  placeholder,
  value,
}: {
  accessibilityLabel: string;
  mode: PickerMode;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parsePickerValue(value, mode);

  return (
    <View>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={styles.pickerField}
      >
        <Text style={[styles.pickerFieldText, !value && styles.pickerFieldPlaceholder]}>
          {value || placeholder}
        </Text>
      </Pressable>
      {mode === 'date' ? (
        <DatePickerSheet
          onClose={() => setOpen(false)}
          onSelect={(date) => onChange(formatDateValue(date))}
          selectedDate={selected}
          visible={open}
        />
      ) : (
        <TimePickerSheet
          onClose={() => setOpen(false)}
          onSelect={onChange}
          selectedTime={selected}
          visible={open}
        />
      )}
    </View>
  );
}
