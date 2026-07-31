import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { TimePickerSheet } from '@/shared/components/TimePickerSheet';

describe('TimePickerSheet', () => {
  it('is hidden when not visible', () => {
    render(
      <TimePickerSheet
        visible={false}
        selectedTime={new Date(2026, 6, 31, 9, 5)}
        onClose={jest.fn()}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.queryByText('选择时间')).toBeNull();
  });

  it('lets the user change hour/minute and confirm', () => {
    const onSelect = jest.fn();
    const onClose = jest.fn();
    render(
      <TimePickerSheet
        visible
        selectedTime={new Date(2026, 6, 31, 9, 5)}
        onClose={onClose}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('09:05')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('15 时'));
    fireEvent.press(screen.getByLabelText('30 分'));
    expect(screen.getByText('15:30')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('确认时间'));
    expect(onSelect).toHaveBeenCalledWith('15:30');
    expect(onClose).toHaveBeenCalled();
  });
});
