import {
  addLocalDays,
  isValidIanaTimezone,
  parseDateOnly,
  parseIsoInstant,
  zonedPartsToInstant,
} from '../domain/scheduleDateTime';
import { createMockPreviewCatalog, type MockPreviewCatalog } from './mockPreviewSchedules';
import type {
  GetLocationSchedulesQuery,
  GetSchedulesByDayQuery,
  GetSchedulesByRangeQuery,
  LocationScheduleView,
  ScheduleCalendarReadService,
  ScheduleOccurrenceView,
} from './scheduleClientService';

/** 预览用只读日历：返回相对今天的示例日程，不碰 SQLite 或后端。 */
export class MockScheduleClientService implements ScheduleCalendarReadService {
  private readonly catalog: MockPreviewCatalog;

  public constructor(now: () => Date = () => new Date()) {
    this.catalog = createMockPreviewCatalog(now());
  }

  public async getSchedulesByDay(
    query: GetSchedulesByDayQuery,
  ): Promise<readonly ScheduleOccurrenceView[]> {
    const selectedDate = parseDateOnly(query.selectedDate);
    if (
      query.accountId.trim().length === 0 ||
      selectedDate === null ||
      !isValidIanaTimezone(query.timezone)
    ) {
      throw new TypeError('Invalid local calendar query');
    }
    const dayStart = zonedPartsToInstant(selectedDate, query.timezone);
    const dayEnd = zonedPartsToInstant(addLocalDays(selectedDate, 1), query.timezone);
    return this.catalog.occurrences
      .filter((item) => overlapsRange(item, dayStart, dayEnd))
      .slice()
      .sort(compareOccurrences);
  }

  public async getSchedulesByRange(
    query: GetSchedulesByRangeQuery,
  ): Promise<readonly ScheduleOccurrenceView[]> {
    const startDate = parseDateOnly(query.startDate);
    const endDate = parseDateOnly(query.endDate);
    if (
      query.accountId.trim().length === 0 ||
      startDate === null ||
      endDate === null ||
      !isValidIanaTimezone(query.timezone)
    ) {
      throw new TypeError('Invalid local calendar range query');
    }
    const rangeStart = zonedPartsToInstant(startDate, query.timezone);
    const rangeEnd = zonedPartsToInstant(endDate, query.timezone);
    if (rangeStart >= rangeEnd) {
      throw new TypeError('Invalid local calendar range query');
    }
    return this.catalog.occurrences
      .filter((item) => overlapsRange(item, rangeStart, rangeEnd))
      .slice()
      .sort(compareOccurrences);
  }

  public async getLocationSchedules(
    query: GetLocationSchedulesQuery,
  ): Promise<readonly LocationScheduleView[]> {
    if (query.accountId.trim().length === 0) {
      throw new TypeError('Invalid location schedule query');
    }
    return this.catalog.locations;
  }
}

function overlapsRange(item: ScheduleOccurrenceView, rangeStart: Date, rangeEnd: Date): boolean {
  const start = requireInstant(item.occurrenceStart);
  if (item.isAllDay) {
    const end = item.occurrenceEnd === null ? start : requireInstant(item.occurrenceEnd);
    return start < rangeEnd && end > rangeStart;
  }
  return start >= rangeStart && start < rangeEnd;
}

function requireInstant(value: string | null): Date {
  const parsed = parseIsoInstant(value);
  if (parsed === null) {
    throw new TypeError(`Invalid timestamp ${value}`);
  }
  return parsed;
}

function compareOccurrences(left: ScheduleOccurrenceView, right: ScheduleOccurrenceView): number {
  if (left.isAllDay !== right.isAllDay) {
    return left.isAllDay ? -1 : 1;
  }
  return (
    (left.occurrenceStart ?? '').localeCompare(right.occurrenceStart ?? '') ||
    left.title.localeCompare(right.title) ||
    left.scheduleId.localeCompare(right.scheduleId)
  );
}
