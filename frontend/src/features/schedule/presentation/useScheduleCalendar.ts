import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  GetSchedulesByDayQuery,
  ScheduleClientService,
  ScheduleOccurrenceView,
} from '../application';
import { addDays, dateKey, dateKeyInTimezone, startOfMonth } from './scheduleDisplay';

export interface ScheduleCalendarState {
  selectedDate: Date;
  visibleMonth: Date;
  occurrencesByDate: ReadonlyMap<string, readonly ScheduleOccurrenceView[]>;
  selectedOccurrences: readonly ScheduleOccurrenceView[];
  loading: boolean;
  error: string | null;
  selectDate: (date: Date) => void;
  changeMonth: (offset: number) => void;
  retry: () => void;
}

function monthGridDates(month: Date): Date[] {
  const first = startOfMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => addDays(first, index - mondayOffset));
}

export function useScheduleCalendar(
  service: ScheduleClientService,
  accountId: string,
  timezone: string,
  initialDate = new Date(),
): ScheduleCalendarState {
  const [selectedDate, setSelectedDate] = useState(() => initialDate);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(initialDate));
  const [occurrencesByDate, setOccurrencesByDate] = useState<
    ReadonlyMap<string, readonly ScheduleOccurrenceView[]>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const dates = monthGridDates(visibleMonth);
    Promise.resolve().then(() => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
    });
    Promise.all(
      dates.map(async (date) => {
        const query: GetSchedulesByDayQuery = {
          accountId,
          selectedDate: dateKey(date),
          timezone,
        };
        return [dateKey(date), await service.getSchedulesByDay(query)] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setOccurrencesByDate(new Map(entries));
      })
      .catch(() => {
        if (!cancelled) setError('日程加载失败，请重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, reloadToken, service, timezone, visibleMonth]);

  const selectedOccurrences = useMemo(
    () => occurrencesByDate.get(dateKey(selectedDate)) ?? [],
    [occurrencesByDate, selectedDate],
  );

  const selectDate = useCallback((date: Date) => {
    setSelectedDate(date);
    setVisibleMonth(startOfMonth(date));
  }, []);

  const changeMonth = useCallback((offset: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }, []);

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);

  return {
    selectedDate,
    visibleMonth,
    occurrencesByDate,
    selectedOccurrences,
    loading,
    error,
    selectDate,
    changeMonth,
    retry,
  };
}

export { dateKeyInTimezone };
