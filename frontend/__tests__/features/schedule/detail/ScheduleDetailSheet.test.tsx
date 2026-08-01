import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { makeSchedule } from '@test/fixtures';
import { ScheduleDetailSheet } from '@/features/schedule/detail/ScheduleDetailSheet';
import { AppDialogProvider } from '@/shared/components/AppDialogProvider';

function renderWithDialog(element: ReactElement) {
  return render(<AppDialogProvider>{element}</AppDialogProvider>);
}

describe('ScheduleDetailSheet', () => {
  it('is hidden when schedule is null', () => {
    renderWithDialog(
      <ScheduleDetailSheet schedule={null} onClose={jest.fn()} onOpenDay={jest.fn()} />,
    );
    expect(screen.queryByText('安排详情')).toBeNull();
  });

  it('shows schedule content and opens the day view', () => {
    const onClose = jest.fn();
    const onOpenDay = jest.fn();
    renderWithDialog(
      <ScheduleDetailSheet
        schedule={makeSchedule({
          title: '评审会',
          status: 'deleted',
          start_time: new Date(2026, 6, 31, 9, 0).toISOString(),
          end_time: new Date(2026, 6, 31, 10, 0).toISOString(),
        })}
        onClose={onClose}
        onOpenDay={onOpenDay}
      />,
    );
    expect(screen.getByText('评审会')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('查看当天日程'));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenDay).toHaveBeenCalled();
  });

  it('offers edit when editable and confirms delete', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    const onClose = jest.fn();
    renderWithDialog(
      <ScheduleDetailSheet
        schedule={makeSchedule({
          title: '评审会',
          start_time: new Date(2026, 6, 31, 9, 0).toISOString(),
          end_time: new Date(2026, 6, 31, 10, 0).toISOString(),
        })}
        onClose={onClose}
        onDelete={onDelete}
        onEdit={onEdit}
        onOpenDay={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByLabelText('编辑日程'));
    expect(onEdit).toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText('删除日程'));
    expect(screen.getByText('确定删除这个日程吗？相关提醒也会一并取消。')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('删除'));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('renders completed status styling', () => {
    renderWithDialog(
      <ScheduleDetailSheet
        schedule={makeSchedule({
          title: '评审会',
          status: 'done',
          start_time: new Date(2026, 6, 31, 9, 0).toISOString(),
        })}
        onClose={jest.fn()}
        onOpenDay={jest.fn()}
      />,
    );
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0);
    expect(screen.getByText('已完成 · 可回顾这次安排')).toBeTruthy();
  });
});
