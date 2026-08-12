import { act, renderHook, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type { ScheduleClientService } from '../application';
import { useScheduleCalendar } from './useScheduleCalendar';

describe('useScheduleCalendar', () => {
  it('loads a 42-day grid through one range query and selects the first day when changing month', async () => {
    const getSchedulesByRange = jest
      .fn<ScheduleClientService['getSchedulesByRange']>()
      .mockResolvedValue([]);
    const service = { getSchedulesByRange, getSchedulesByDay: jest.fn() } as ScheduleClientService;
    const { result } = renderHook(() =>
      useScheduleCalendar(service, 'account-a', 'Asia/Shanghai', new Date(2026, 7, 12)),
    );

    await waitFor(() => expect(getSchedulesByRange).toHaveBeenCalledTimes(1));
    expect(getSchedulesByRange).toHaveBeenCalledWith({
      accountId: 'account-a',
      startDate: '2026-07-27',
      endDate: '2026-09-07',
      timezone: 'Asia/Shanghai',
    });
    expect(service.getSchedulesByDay).not.toHaveBeenCalled();

    act(() => result.current.changeMonth(1));
    expect(result.current.visibleMonth).toEqual(new Date(2026, 8, 1));
    expect(result.current.selectedDate).toEqual(new Date(2026, 8, 1));
    await waitFor(() => expect(getSchedulesByRange).toHaveBeenCalledTimes(2));
  });
});
