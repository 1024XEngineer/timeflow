import { render, screen } from '@testing-library/react-native';
import { describe, expect, it } from '@jest/globals';

import type {
  LocationScheduleView,
  ScheduleOccurrenceView,
} from '../../../../../src/features/schedule/application';
import { LocationScheduleRow } from '../../../../../src/features/schedule/presentation/LocationScheduleRow';
import { ScheduleOccurrenceRow } from '../../../../../src/features/schedule/presentation/ScheduleOccurrenceRow';

function occurrence(overrides: Partial<ScheduleOccurrenceView> = {}): ScheduleOccurrenceView {
  return {
    scheduleId: 'schedule-a',
    scheduleCategory: 'time',
    category: 'work',
    recurrenceMode: 'once',
    title: '团队周会',
    isAllDay: false,
    timezone: 'Asia/Shanghai',
    locationName: '上海科技馆',
    reminderType: 'before_start',
    reminderStrength: 'medium',
    occurrenceStart: '2026-08-13T06:00:00.000Z',
    occurrenceEnd: '2026-08-13T07:00:00.000Z',
    ...overrides,
  };
}

describe('ScheduleOccurrenceRow', () => {
  it('does not show a recurrence badge for a one-time schedule', () => {
    render(<ScheduleOccurrenceRow item={occurrence()} />);

    expect(screen.getByText('团队周会')).toBeTruthy();
    expect(screen.queryByText('重复')).toBeNull();
  });

  it('shows a recurrence badge for a recurring schedule', () => {
    render(<ScheduleOccurrenceRow item={occurrence({ recurrenceMode: 'recurring' })} />);

    expect(screen.getByText('重复')).toBeTruthy();
  });

  it('shows localized work and study category badges', () => {
    const view = render(<ScheduleOccurrenceRow item={occurrence({ category: 'work' })} />);

    expect(screen.getByText('工作')).toBeTruthy();
    view.rerender(<ScheduleOccurrenceRow item={occurrence({ category: 'study' })} />);
    expect(screen.getByText('学习')).toBeTruthy();
  });

  it('does not show a category badge while category is null', () => {
    render(<ScheduleOccurrenceRow item={occurrence({ category: null })} />);

    expect(screen.queryByText('工作')).toBeNull();
    expect(screen.queryByText('其他')).toBeNull();
    expect(screen.queryByText('未分类')).toBeNull();
  });

  it('shows an explicit all-day label for an all-day schedule', () => {
    render(
      <ScheduleOccurrenceRow
        item={occurrence({
          isAllDay: true,
          occurrenceStart: '2026-08-12T16:00:00.000Z',
          occurrenceEnd: '2026-08-13T16:00:00.000Z',
          title: '团队休息日',
        })}
      />,
    );

    expect(screen.getByText('全天')).toBeTruthy();
  });
});

describe('LocationScheduleRow', () => {
  it('shows human-readable content without exposing raw enums', () => {
    const item: LocationScheduleView = {
      scheduleId: 'location-a',
      scheduleCategory: 'location',
      title: '到公司提醒我打卡',
      timezone: 'Asia/Shanghai',
      locationName: '公司',
      reminderType: 'arrive_location',
      reminderStrength: 'high',
    };

    render(<LocationScheduleRow item={item} />);

    expect(screen.getByText('位置日程')).toBeTruthy();
    expect(screen.getByText('到公司提醒我打卡')).toBeTruthy();
    expect(screen.getByText('公司')).toBeTruthy();
    expect(screen.queryByText('location')).toBeNull();
    expect(screen.queryByText('arrive_location')).toBeNull();
    expect(screen.queryByText('high')).toBeNull();
    expect(screen.queryByText('strong')).toBeNull();
  });
});
