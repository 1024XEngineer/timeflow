import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  GetSchedulesByRangeQuery,
  LocationScheduleView,
  ScheduleCalendarReadService,
  ScheduleOccurrenceView,
} from '../application';
import {
  floatingDateToLocalParts,
  instantToZonedParts,
  localPartsToFloatingDate,
  zonedPartsToInstant,
} from '../domain/scheduleDateTime';
import {
  normalizeUtcUntilForFloatingRrule,
  parseScheduleRrule,
} from '../domain/scheduleRecurrence';
import { addDays, dateKey, dateKeyInTimezone, startOfMonth } from './scheduleDisplay';
import type { CalendarFocusTarget } from './calendarFocus';

export interface ScheduleCalendarState {
  selectedDate: Date;
  visibleMonth: Date;
  occurrencesByDate: ReadonlyMap<string, readonly ScheduleOccurrenceView[]>;
  selectedOccurrences: readonly ScheduleOccurrenceView[];
  locationSchedules: readonly LocationScheduleView[];
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
  service: ScheduleCalendarReadService,
  accountId: string,
  timezone: string,
  initialDate = new Date(),
  /** 外部触发刷新用（比如语音写完一条日程）；变化时跟 retry() 走同一条重取路径。 */
  refreshSignal = 0,
  focusTarget?: CalendarFocusTarget | null,
): ScheduleCalendarState {
  const [selectedDate, setSelectedDate] = useState(() => initialDate);
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(initialDate));
  const [occurrencesByDate, setOccurrencesByDate] = useState<
    ReadonlyMap<string, readonly ScheduleOccurrenceView[]>
  >(new Map());
  const [locationSchedules, setLocationSchedules] = useState<readonly LocationScheduleView[]>([]);
  const [occurrencesLoading, setOccurrencesLoading] = useState(true);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [occurrencesError, setOccurrencesError] = useState<string | null>(null);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const focusKey = focusTarget
    ? `${focusTarget.scheduleId}:${focusTarget.kind}:${focusTarget.recurrenceMode}:${focusTarget.startTime ?? ''}`
    : null;

  useEffect(() => {
    if (focusTarget === undefined || focusTarget === null || focusTarget.kind === 'location') {
      return;
    }

    let cancelled = false;
    const applyDate = (date: Date) => {
      if (cancelled) return;
      setSelectedDate(date);
      setVisibleMonth(startOfMonth(date));
    };

    if (focusTarget.recurrenceMode !== 'recurring') {
      const dateKeyForTarget = focusTarget.startTime
        ? dateKeyInTimezone(focusTarget.startTime, timezone)
        : null;
      const date = dateKeyForTarget ? parseDateKey(dateKeyForTarget) : null;
      if (date !== null) applyDate(date);
      return () => {
        cancelled = true;
      };
    }

    void findNextOccurrenceDate(service, accountId, timezone, focusTarget)
      .then((date) => {
        if (date !== null) applyDate(date);
      })
      .catch(() => {
        if (!cancelled) setOccurrencesError('日程加载失败，请重试');
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, focusKey, focusTarget, refreshSignal, service, timezone]);

  useEffect(() => {
    let cancelled = false;
    const dates = monthGridDates(visibleMonth);
    const startDate = dateKey(dates[0]);
    const endDate = dateKey(addDays(dates[dates.length - 1], 1));
    Promise.resolve().then(() => {
      if (!cancelled) {
        setOccurrencesLoading(true);
        setOccurrencesError(null);
      }
    });
    const query: GetSchedulesByRangeQuery = { accountId, startDate, endDate, timezone };
    service
      .getSchedulesByRange(query)
      .then((occurrences) => {
        const entries = new Map<string, ScheduleOccurrenceView[]>();
        for (const occurrence of occurrences) {
          const occurrenceStartKey = occurrence.occurrenceStart
            ? dateKeyInTimezone(occurrence.occurrenceStart, timezone)
            : null;
          if (occurrenceStartKey === null) continue;
          const keys =
            occurrence.isAllDay && occurrence.occurrenceEnd
              ? dates
                  .filter((date) => {
                    const key = dateKey(date);
                    const startKey = occurrenceStartKey;
                    const endKey = dateKeyInTimezone(occurrence.occurrenceEnd!, timezone);
                    return endKey !== null && key >= startKey && key < endKey;
                  })
                  .map(dateKey)
              : [occurrenceStartKey];
          for (const key of keys) {
            const values = entries.get(key) ?? [];
            values.push(occurrence);
            entries.set(key, values);
          }
        }
        if (!cancelled) setOccurrencesByDate(entries);
      })
      .catch(() => {
        if (!cancelled) setOccurrencesError('日程加载失败，请重试');
      })
      .finally(() => {
        if (!cancelled) setOccurrencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, reloadToken, refreshSignal, service, timezone, visibleMonth]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) {
        setLocationsLoading(true);
        setLocationsError(null);
      }
    });
    service
      .getLocationSchedules({ accountId })
      .then((schedules) => {
        if (!cancelled) setLocationSchedules(schedules);
      })
      .catch(() => {
        if (!cancelled) setLocationsError('地点提醒加载失败，请重试');
      })
      .finally(() => {
        if (!cancelled) setLocationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, reloadToken, refreshSignal, service]);

  const selectedOccurrences = useMemo(
    () => occurrencesByDate.get(dateKey(selectedDate)) ?? [],
    [occurrencesByDate, selectedDate],
  );

  const selectDate = useCallback((date: Date) => {
    setSelectedDate(date);
    setVisibleMonth((current) => {
      const nextMonth = startOfMonth(date);
      return current.getFullYear() === nextMonth.getFullYear() &&
        current.getMonth() === nextMonth.getMonth()
        ? current
        : nextMonth;
    });
  }, []);

  const changeMonth = useCallback(
    (offset: number) => {
      const nextMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + offset, 1);
      setVisibleMonth(nextMonth);
      setSelectedDate(nextMonth);
    },
    [visibleMonth],
  );

  const retry = useCallback(() => setReloadToken((value) => value + 1), []);

  return {
    selectedDate,
    visibleMonth,
    occurrencesByDate,
    selectedOccurrences,
    locationSchedules,
    loading: occurrencesLoading || locationsLoading,
    error: occurrencesError ?? locationsError,
    selectDate,
    changeMonth,
    retry,
  };
}

function parseDateKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateKey(date) === value ? date : null;
}

async function findNextOccurrenceDate(
  service: ScheduleCalendarReadService,
  accountId: string,
  timezone: string,
  target: CalendarFocusTarget,
): Promise<Date | null> {
  const now = new Date();
  const scheduleTimezone = target.timezone ?? timezone;
  if (target.startTime === null || target.recurrenceRule === null) return null;
  const scheduleStart = new Date(target.startTime);
  if (Number.isNaN(scheduleStart.getTime())) return null;
  const floatingStart = localPartsToFloatingDate(
    instantToZonedParts(scheduleStart, scheduleTimezone),
  );
  const floatingNow = localPartsToFloatingDate(instantToZonedParts(now, scheduleTimezone));
  const rule = parseScheduleRrule(
    normalizeUtcUntilForFloatingRrule(target.recurrenceRule, scheduleTimezone),
    floatingStart,
  );
  const nextFloating = rule.after(floatingNow, false);
  if (nextFloating === null) return null;
  const nextInstant = zonedPartsToInstant(floatingDateToLocalParts(nextFloating), scheduleTimezone);
  const startKey = dateKeyInTimezone(nextInstant.toISOString(), timezone);
  const startDate = startKey ? parseDateKey(startKey) : null;
  if (startDate === null || startKey === null) return null;
  const occurrences = await service.getSchedulesByRange({
    accountId,
    endDate: dateKey(addDays(startDate, 1)),
    startDate: startKey,
    timezone,
  });
  const next = occurrences
    .filter(
      (occurrence) =>
        occurrence.scheduleId === target.scheduleId &&
        occurrence.occurrenceStart !== null &&
        new Date(occurrence.occurrenceStart).getTime() >= now.getTime(),
    )
    .sort(
      (left, right) =>
        new Date(left.occurrenceStart!).getTime() - new Date(right.occurrenceStart!).getTime(),
    )[0];
  const nextKey = next?.occurrenceStart ? dateKeyInTimezone(next.occurrenceStart, timezone) : null;
  return nextKey ? parseDateKey(nextKey) : null;
}
