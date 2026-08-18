import type { LocationScheduleView, ScheduleOccurrenceView } from './scheduleClientService';
import {
  addLocalDays,
  instantToZonedParts,
  zonedPartsToInstant,
  type LocalDateTimeParts,
} from '../domain/scheduleDateTime';

export const MOCK_PREVIEW_TIMEZONE = 'Asia/Shanghai';

export interface MockPreviewCatalog {
  readonly locations: readonly LocationScheduleView[];
  readonly occurrences: readonly ScheduleOccurrenceView[];
}

/** 相对“今天”生成预览日历，避免写死日期导致打开时是空的。 */
export function createMockPreviewCatalog(
  now: Date,
  timezone = MOCK_PREVIEW_TIMEZONE,
): MockPreviewCatalog {
  const today = dateOnly(instantToZonedParts(now, timezone));
  const meetingStart = atLocalTime(today, timezone, 0, 9, 30);
  const meetingEnd = atLocalTime(today, timezone, 0, 10, 30);
  const allDayStart = atLocalTime(today, timezone, 0, 0, 0);
  const allDayEnd = atLocalTime(today, timezone, 1, 0, 0);
  const reviewStart = atLocalTime(today, timezone, 1, 14, 0);
  const reviewEnd = atLocalTime(today, timezone, 1, 15, 30);

  return {
    locations: [
      {
        scheduleId: 'mock-preview-location-parking',
        scheduleCategory: 'location',
        title: '取车提醒',
        timezone,
        locationName: '停车场 B2',
        reminderType: 'return_to_recorded_location',
        reminderStrength: 'high',
      },
    ],
    occurrences: [
      {
        scheduleId: 'mock-preview-all-day-offsite',
        scheduleCategory: 'time',
        recurrenceMode: 'once',
        title: '团队共创日',
        isAllDay: true,
        timezone,
        locationName: '203 会议室',
        reminderType: 'at_time',
        reminderStrength: 'low',
        occurrenceStart: allDayStart.toISOString(),
        occurrenceEnd: allDayEnd.toISOString(),
      },
      {
        scheduleId: 'mock-preview-time-standup',
        scheduleCategory: 'time',
        recurrenceMode: 'once',
        title: '项目例会',
        isAllDay: false,
        timezone,
        locationName: '203 会议室',
        reminderType: 'before_start',
        reminderStrength: 'medium',
        occurrenceStart: meetingStart.toISOString(),
        occurrenceEnd: meetingEnd.toISOString(),
      },
      {
        scheduleId: 'mock-preview-time-review',
        scheduleCategory: 'time',
        recurrenceMode: 'once',
        title: '设计评审',
        isAllDay: false,
        timezone,
        locationName: null,
        reminderType: 'before_start',
        reminderStrength: 'medium',
        occurrenceStart: reviewStart.toISOString(),
        occurrenceEnd: reviewEnd.toISOString(),
      },
    ],
  };
}

function dateOnly(parts: LocalDateTimeParts): LocalDateTimeParts {
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

function atLocalTime(
  today: LocalDateTimeParts,
  timezone: string,
  dayOffset: number,
  hour: number,
  minute: number,
): Date {
  const day = addLocalDays(today, dayOffset);
  return zonedPartsToInstant(
    {
      ...day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    timezone,
  );
}
