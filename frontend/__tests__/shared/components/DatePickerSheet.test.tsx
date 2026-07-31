import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('react-native-calendars', () => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    LocaleConfig: { locales: {}, defaultLocale: 'zh' },
    Calendar: ({
      onDayPress,
      markedDates,
    }: {
      onDayPress: (day: { dateString: string }) => void;
      markedDates?: Record<string, unknown>;
    }) =>
      React.createElement(
        Pressable,
        {
          accessibilityLabel: 'mock-calendar-day',
          onPress: () => onDayPress({ dateString: '2026-08-02' }),
        },
        React.createElement(Text, null, `marks:${Object.keys(markedDates ?? {}).join(',')}`),
      ),
  };
});

import { DatePickerSheet } from '@/shared/components/DatePickerSheet';

describe('DatePickerSheet', () => {
  it('is hidden when not visible', () => {
    render(
      <DatePickerSheet
        visible={false}
        selectedDate={new Date(2026, 6, 31)}
        onClose={jest.fn()}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.queryByLabelText('mock-calendar-day')).toBeNull();
  });

  it('selects a day and can jump to today', () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    render(
      <DatePickerSheet
        visible
        markedDateKeys={['2026-07-31']}
        selectedDate={new Date(2026, 6, 31)}
        onClose={onClose}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText(/marks:2026-07-31/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('mock-calendar-day'));
    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText('回到今天'));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
