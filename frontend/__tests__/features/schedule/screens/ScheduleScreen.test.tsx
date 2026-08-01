import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { makeSchedule } from '@test/fixtures';

jest.mock('@/shared/hooks/useCurrentDate', () => ({
  useCurrentDate: () => new Date(2026, 6, 31, 12, 0, 0),
}));

jest.mock('@/shared/components/DatePickerSheet', () => ({
  DatePickerSheet: () => null,
}));

import { ScheduleScreen } from '@/features/schedule/screens/ScheduleScreen';
import { AppDialogProvider } from '@/shared/components/AppDialogProvider';

function renderWithDialog(element: ReactElement) {
  return render(<AppDialogProvider>{element}</AppDialogProvider>);
}

describe('ScheduleScreen', () => {
  const props = {
    onCreate: jest.fn(),
    onDeleteSchedule: jest.fn(),
    onEditSchedule: jest.fn(),
    scheduleItems: [
      makeSchedule({
        id: 't1',
        title: '今日评审',
        start_time: new Date(2026, 6, 31, 10, 0).toISOString(),
      }),
    ],
  };

  it('shows the month view by default', () => {
    renderWithDialog(<ScheduleScreen {...props} />);
    expect(screen.getAllByText('7月').length).toBeGreaterThan(0);
    expect(screen.getByText('今日评审')).toBeTruthy();
  });

  it('opens create from the add button', () => {
    renderWithDialog(<ScheduleScreen {...props} />);
    fireEvent.press(screen.getByLabelText('添加日程'));
    expect(props.onCreate).toHaveBeenCalled();
  });

  it('routes completion from both the agenda row and detail sheet', () => {
    const onToggleSchedule = jest.fn();
    renderWithDialog(<ScheduleScreen {...props} onToggleSchedule={onToggleSchedule} />);

    fireEvent.press(screen.getByLabelText('完成 今日评审'));
    expect(onToggleSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));

    fireEvent.press(screen.getByLabelText('10:00 今日评审'));
    fireEvent.press(screen.getByLabelText('完成日程'));
    expect(onToggleSchedule).toHaveBeenCalledTimes(2);
  });

  it('disables mutation affordances until the schedule service is ready', () => {
    const onToggleSchedule = jest.fn();
    renderWithDialog(
      <ScheduleScreen {...props} canMutate={false} onToggleSchedule={onToggleSchedule} />,
    );

    expect(screen.getByLabelText('添加日程').props.accessibilityState).toEqual({ disabled: true });
    expect(screen.getByLabelText('完成 今日评审').props.accessibilityState).toEqual({
      checked: false,
      disabled: true,
    });
    fireEvent.press(screen.getByLabelText('完成 今日评审'));
    expect(onToggleSchedule).not.toHaveBeenCalled();
  });
});
