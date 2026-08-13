import { act, renderHook, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type { ScheduleCalendarReadService } from '../../../../../src/features/schedule/application';
import { useScheduleCalendar } from '../../../../../src/features/schedule/presentation/useScheduleCalendar';

describe('useScheduleCalendar', () => {
  it('loads a 42-day grid through one range query and selects the first day when changing month', async () => {
    const getSchedulesByRange = jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockResolvedValue([]);
    const getLocationSchedules = jest
      .fn<ScheduleCalendarReadService['getLocationSchedules']>()
      .mockResolvedValue([
        {
          scheduleId: 'location-a',
          scheduleCategory: 'location',
          title: '到公司提醒我打卡',
          timezone: 'Asia/Shanghai',
          locationName: '公司',
          reminderType: 'arrive_location',
          reminderStrength: 'high',
        },
      ]);
    const service = {
      getSchedulesByRange,
      getSchedulesByDay: jest.fn(),
      getLocationSchedules,
    } as ScheduleCalendarReadService;
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
    await waitFor(() => expect(getLocationSchedules).toHaveBeenCalledTimes(1));
    expect(getLocationSchedules).toHaveBeenCalledWith({ accountId: 'account-a' });
    expect(result.current.locationSchedules).toHaveLength(1);

    act(() => result.current.selectDate(new Date(2026, 7, 13)));
    expect(result.current.locationSchedules).toHaveLength(1);
    expect(getLocationSchedules).toHaveBeenCalledTimes(1);
    expect(getSchedulesByRange).toHaveBeenCalledTimes(1);
    const rangeCallsBeforeMonthChange = getSchedulesByRange.mock.calls.length;

    act(() => result.current.changeMonth(1));
    expect(result.current.visibleMonth).toEqual(new Date(2026, 8, 1));
    expect(result.current.selectedDate).toEqual(new Date(2026, 8, 1));
    await waitFor(() =>
      expect(getSchedulesByRange).toHaveBeenCalledTimes(rangeCallsBeforeMonthChange + 1),
    );
    expect(result.current.locationSchedules).toHaveLength(1);
    expect(getLocationSchedules).toHaveBeenCalledTimes(1);
  });
});
