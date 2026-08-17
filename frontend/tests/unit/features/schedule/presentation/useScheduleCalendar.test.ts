import { act, renderHook, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type { ScheduleCalendarReadService } from '../../../../../src/features/schedule/application';
import type { CalendarFocusTarget } from '../../../../../src/features/schedule/presentation/calendarFocus';
import { useScheduleCalendar } from '../../../../../src/features/schedule/presentation/useScheduleCalendar';

describe('useScheduleCalendar', () => {
  it('focuses a newly created one-time schedule and refreshes the new month', async () => {
    const getSchedulesByRange = jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockResolvedValue([]);
    const service = {
      getSchedulesByRange,
      getSchedulesByDay: jest.fn(),
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
    } as ScheduleCalendarReadService;
    const target: CalendarFocusTarget = {
      kind: 'time',
      recurrenceMode: 'once',
      recurrenceRule: null,
      scheduleId: 'new-schedule',
      startTime: '2026-08-24T07:00:00Z',
      timezone: 'Asia/Shanghai',
    };
    const { result, rerender } = renderHook(
      ({ focusTarget }: { focusTarget: CalendarFocusTarget | null }) =>
        useScheduleCalendar(
          service,
          'account-a',
          'Asia/Shanghai',
          new Date(2026, 7, 14),
          0,
          focusTarget,
        ),
      { initialProps: { focusTarget: null } },
    );

    await waitFor(() => expect(getSchedulesByRange).toHaveBeenCalledTimes(1));
    rerender({ focusTarget: target });
    await waitFor(() => expect(result.current.selectedDate).toEqual(new Date(2026, 7, 24)));
    expect(result.current.visibleMonth).toEqual(new Date(2026, 7, 1));
    await waitFor(() => expect(getSchedulesByRange).toHaveBeenCalledTimes(2));
  });

  it('uses the nearest future occurrence for a recurring focus target', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    const occurrence = {
      scheduleId: 'weekly',
      scheduleCategory: 'time' as const,
      recurrenceMode: 'recurring' as const,
      title: 'Weekly meeting',
      isAllDay: false,
      timezone: 'Asia/Shanghai',
      locationName: null,
      reminderType: null,
      reminderStrength: null,
      occurrenceStart: '2026-08-17T02:00:00Z',
      occurrenceEnd: null,
    };
    const getSchedulesByRange = jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockResolvedValue([occurrence]);
    const service = {
      getSchedulesByRange,
      getSchedulesByDay: jest.fn(),
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
    } as ScheduleCalendarReadService;
    const target: CalendarFocusTarget = {
      kind: 'time',
      recurrenceMode: 'recurring',
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
      scheduleId: 'weekly',
      startTime: '2026-08-03T02:00:00Z',
      timezone: 'Asia/Shanghai',
    };
    const { result } = renderHook(() =>
      useScheduleCalendar(service, 'account-a', 'Asia/Shanghai', new Date(2026, 7, 14), 1, target),
    );

    await waitFor(() => expect(result.current.selectedDate).toEqual(new Date(2026, 7, 17)));
    expect(result.current.visibleMonth).toEqual(new Date(2026, 7, 1));
    expect(getSchedulesByRange).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-08-17', endDate: '2026-08-18' }),
    );
    jest.useRealTimers();
  });

  it('does not change the selected date for a location focus target', async () => {
    const service = {
      getSchedulesByRange: jest
        .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
        .mockResolvedValue([]),
      getSchedulesByDay: jest.fn(),
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
    } as ScheduleCalendarReadService;
    const target: CalendarFocusTarget = {
      kind: 'location',
      recurrenceMode: null,
      recurrenceRule: null,
      scheduleId: 'location-a',
      startTime: null,
      timezone: 'Asia/Shanghai',
    };
    const { result } = renderHook(() =>
      useScheduleCalendar(service, 'account-a', 'Asia/Shanghai', new Date(2026, 7, 14), 1, target),
    );

    await waitFor(() => expect(service.getSchedulesByRange).toHaveBeenCalledTimes(1));
    expect(result.current.selectedDate).toEqual(new Date(2026, 7, 14));
  });

  it('keeps the current date and surfaces an error when recurring focus lookup fails', async () => {
    const service = {
      getSchedulesByRange: jest
        .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
        .mockRejectedValue(new Error('sqlite unavailable')),
      getSchedulesByDay: jest.fn(),
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
    } as ScheduleCalendarReadService;
    const target: CalendarFocusTarget = {
      kind: 'time',
      recurrenceMode: 'recurring',
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
      scheduleId: 'weekly',
      startTime: '2026-08-03T02:00:00Z',
      timezone: 'Asia/Shanghai',
    };
    const { result } = renderHook(() =>
      useScheduleCalendar(service, 'account-a', 'Asia/Shanghai', new Date(2026, 7, 14), 1, target),
    );

    await waitFor(() => expect(result.current.error).toBe('日程加载失败，请重试'));
    expect(result.current.selectedDate).toEqual(new Date(2026, 7, 14));
  });

  it('retries a failed recurring focus lookup and applies the resolved date', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    const occurrence = {
      scheduleId: 'yearly',
      scheduleCategory: 'time' as const,
      recurrenceMode: 'recurring' as const,
      title: 'Yearly meeting',
      isAllDay: false,
      timezone: 'Asia/Shanghai',
      locationName: null,
      reminderType: null,
      reminderStrength: null,
      occurrenceStart: '2026-10-05T02:00:00Z',
      occurrenceEnd: null,
    };
    const getSchedulesByRange = jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockRejectedValueOnce(new Error('sqlite unavailable'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([occurrence])
      .mockResolvedValue([]);
    const service = {
      getSchedulesByRange,
      getSchedulesByDay: jest.fn(),
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
    } as ScheduleCalendarReadService;
    const target: CalendarFocusTarget = {
      kind: 'time',
      recurrenceMode: 'recurring',
      recurrenceRule: 'FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5',
      scheduleId: 'yearly',
      startTime: '2025-10-05T02:00:00Z',
      timezone: 'Asia/Shanghai',
    };
    const { result } = renderHook(() =>
      useScheduleCalendar(service, 'account-a', 'Asia/Shanghai', new Date(2026, 7, 14), 1, target),
    );

    await waitFor(() => expect(result.current.error).toBe('日程加载失败，请重试'));
    expect(result.current.selectedDate).toEqual(new Date(2026, 7, 14));

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.selectedDate).toEqual(new Date(2026, 9, 5)));
    expect(result.current.visibleMonth).toEqual(new Date(2026, 9, 1));
    expect(result.current.error).toBeNull();
    expect(
      getSchedulesByRange.mock.calls.filter(([query]) => query.startDate === '2026-10-05'),
    ).toHaveLength(2);
    jest.useRealTimers();
  });

  it('resolves a multi-year recurring interval without a one-year search cap', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    const occurrence = {
      scheduleId: 'biennial',
      scheduleCategory: 'time' as const,
      recurrenceMode: 'recurring' as const,
      title: 'Biennial event',
      isAllDay: false,
      timezone: 'Asia/Shanghai',
      locationName: null,
      reminderType: null,
      reminderStrength: null,
      occurrenceStart: '2027-08-24T02:00:00Z',
      occurrenceEnd: null,
    };
    const getSchedulesByRange = jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockResolvedValue([occurrence]);
    const service = {
      getSchedulesByRange,
      getSchedulesByDay: jest.fn(),
      getLocationSchedules: jest
        .fn<ScheduleCalendarReadService['getLocationSchedules']>()
        .mockResolvedValue([]),
    } as ScheduleCalendarReadService;
    const target: CalendarFocusTarget = {
      kind: 'time',
      recurrenceMode: 'recurring',
      recurrenceRule: 'FREQ=YEARLY;INTERVAL=2',
      scheduleId: 'biennial',
      startTime: '2025-08-24T02:00:00Z',
      timezone: 'Asia/Shanghai',
    };
    const { result } = renderHook(() =>
      useScheduleCalendar(service, 'account-a', 'Asia/Shanghai', new Date(2026, 7, 14), 1, target),
    );

    await waitFor(() => expect(result.current.selectedDate).toEqual(new Date(2027, 7, 24)));
    expect(getSchedulesByRange).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2027-08-24', endDate: '2027-08-25' }),
    );
    jest.useRealTimers();
  });

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
