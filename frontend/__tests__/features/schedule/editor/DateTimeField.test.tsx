import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('@/shared/components/DatePickerSheet', () => ({
  DatePickerSheet: ({
    visible,
    onSelect,
    onClose,
  }: {
    visible: boolean;
    onSelect: (date: Date) => void;
    onClose: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    if (!visible) return null;
    return (
      <Pressable
        accessibilityLabel="mock-date-select"
        onPress={() => {
          onSelect(new Date(2026, 7, 1));
          onClose();
        }}
      >
        <Text>mock-date</Text>
      </Pressable>
    );
  },
}));

jest.mock('@/shared/components/TimePickerSheet', () => ({
  TimePickerSheet: ({
    visible,
    onSelect,
    onClose,
  }: {
    visible: boolean;
    onSelect: (value: string) => void;
    onClose: () => void;
  }) => {
    const { Pressable, Text } = require('react-native');
    if (!visible) return null;
    return (
      <Pressable
        accessibilityLabel="mock-time-select"
        onPress={() => {
          onSelect('15:30');
          onClose();
        }}
      >
        <Text>mock-time</Text>
      </Pressable>
    );
  },
}));

import { DateTimeField } from '@/features/schedule/editor/DateTimeField';

describe('DateTimeField', () => {
  it('opens the date sheet and formats the selection', () => {
    const onChange = jest.fn();
    render(
      <DateTimeField
        accessibilityLabel="日期"
        mode="date"
        onChange={onChange}
        placeholder="选择日期"
        value=""
      />,
    );
    fireEvent.press(screen.getByLabelText('日期'));
    fireEvent.press(screen.getByLabelText('mock-date-select'));
    expect(onChange).toHaveBeenCalledWith('2026 / 08 / 01');
  });

  it('opens the time sheet and returns HH:mm', () => {
    const onChange = jest.fn();
    render(
      <DateTimeField
        accessibilityLabel="时间"
        mode="time"
        onChange={onChange}
        placeholder="选择时间"
        value="09:00"
      />,
    );
    expect(screen.getByText('09:00')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('时间'));
    fireEvent.press(screen.getByLabelText('mock-time-select'));
    expect(onChange).toHaveBeenCalledWith('15:30');
  });
});
