import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { makeSchedule } from '@test/fixtures';

import { MonthView } from '@/features/schedule/calendar/MonthView';
import { buildScheduleIndex } from '@/features/schedule/calendar/scheduleIndex';

describe('MonthView', () => {
  const now = new Date(2026, 6, 31);
  const month = new Date(2026, 6, 1);

  it('navigates months and selects a day with events', () => {
    const onMonthChange = jest.fn();
    const onSelectDate = jest.fn();
    const onOpenSchedule = jest.fn();

    render(
      <MonthView
        now={now}
        selectedDate={now}
        visibleMonth={month}
        onMonthChange={onMonthChange}
        onOpenSchedule={onOpenSchedule}
        onSelectDate={onSelectDate}
        scheduleIndex={buildScheduleIndex([
          makeSchedule({
            id: 'm1',
            title: '月底会议',
            start_time: new Date(2026, 6, 31, 14, 0).toISOString(),
          }),
        ])}
      />,
    );

    expect(screen.getByText('7月')).toBeTruthy();
    expect(screen.getByText('月底会议')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('上个月'));
    expect(onMonthChange).toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('下个月'));
    expect(onMonthChange).toHaveBeenCalledTimes(2);

    fireEvent.press(screen.getByText('月底会议'));
    expect(onOpenSchedule).toHaveBeenCalledWith('m1');
  });

  it('shows empty agenda copy when the selected day has no events', () => {
    render(
      <MonthView
        now={now}
        selectedDate={new Date(2026, 6, 1)}
        visibleMonth={month}
        onMonthChange={jest.fn()}
        onOpenSchedule={jest.fn()}
        onSelectDate={jest.fn()}
        scheduleIndex={buildScheduleIndex([])}
      />,
    );
    expect(screen.getByText('这一天暂无详细安排')).toBeTruthy();
  });

  it('renders an undated location reminder and lets the user open it', () => {
    const onOpenSchedule = jest.fn();
    render(
      <MonthView
        now={now}
        selectedDate={now}
        visibleMonth={month}
        onMonthChange={jest.fn()}
        onOpenSchedule={onOpenSchedule}
        onSelectDate={jest.fn()}
        scheduleIndex={buildScheduleIndex([
          makeSchedule({
            id: 'location-1',
            schedule_type: 'location',
            start_time: null,
            title: '到公司提醒',
            location_name: '办公室',
          }),
        ])}
      />,
    );

    expect(screen.getByText('地点提醒')).toBeTruthy();
    fireEvent.press(screen.getByText('到公司提醒'));
    expect(onOpenSchedule).toHaveBeenCalledWith('location-1');
  });
});
