import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { makeSchedule } from '@test/fixtures';

import { ScheduleRow } from '@/features/schedule/calendar/ScheduleRow';

describe('ScheduleRow', () => {
  it('renders title, time and optional meta', () => {
    const onPress = jest.fn();
    const onToggle = jest.fn();
    render(
      <ScheduleRow
        item={makeSchedule({ title: '晨会', location_name: '会议室' })}
        onPress={onPress}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText('晨会')).toBeTruthy();
    expect(screen.getByText('会议室')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('09:05 晨会'));
    expect(onPress).toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('完成 晨会'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('shows restore affordance for done items in compact mode', () => {
    const onToggle = jest.fn();
    render(
      <ScheduleRow
        compact
        item={makeSchedule({ status: 'done', title: '已做完' })}
        onToggle={onToggle}
        showConnector={false}
      />,
    );
    fireEvent.press(screen.getByLabelText('恢复 已做完'));
    expect(onToggle).toHaveBeenCalled();
  });
});
