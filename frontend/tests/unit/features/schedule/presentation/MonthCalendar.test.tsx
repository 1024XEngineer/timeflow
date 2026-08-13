import { fireEvent, render, screen } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';

import { MonthCalendar } from '../../../../../src/features/schedule/presentation/MonthCalendar';

function renderCalendar() {
  const onSelectDate = jest.fn<(date: Date) => void>();
  const onChangeMonth = jest.fn<(offset: number) => void>();
  render(
    <MonthCalendar
      month={new Date(2026, 7, 1)}
      selectedDate={new Date(2026, 7, 13)}
      today={new Date(2026, 7, 13)}
      occurrencesByDate={new Map()}
      onSelectDate={onSelectDate}
      onChangeMonth={onChangeMonth}
    />,
  );
  return { onChangeMonth, onSelectDate };
}

describe('MonthCalendar', () => {
  it('selects valid dates and changes to the previous or next month', () => {
    const { onChangeMonth, onSelectDate } = renderCalendar();

    fireEvent.press(screen.getByLabelText('8月14日'));
    expect(onSelectDate).toHaveBeenCalledTimes(1);
    expect(onSelectDate).toHaveBeenCalledWith(new Date(2026, 7, 14));

    fireEvent.press(screen.getByLabelText('上个月'));
    fireEvent.press(screen.getByLabelText('下个月'));
    expect(onChangeMonth.mock.calls).toEqual([[-1], [1]]);
  });

  it('caps and centers the calendar surface on wide screens', () => {
    renderCalendar();

    expect(StyleSheet.flatten(screen.getByTestId('month-calendar').props.style)).toMatchObject({
      alignSelf: 'center',
      maxWidth: 520,
      width: '92%',
    });
  });
});
