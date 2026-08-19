import { render, screen } from '@testing-library/react-native';
import { describe, expect, it } from '@jest/globals';
import { StyleSheet } from 'react-native';

import type {
  LocationScheduleView,
  ScheduleOccurrenceView,
} from '../../../../../src/features/schedule/application';
import { LocationScheduleRow } from '../../../../../src/features/schedule/presentation/LocationScheduleRow';
import { ScheduleOccurrenceRow } from '../../../../../src/features/schedule/presentation/ScheduleOccurrenceRow';
import { colors } from '../../../../../src/shared/ui/theme';

function occurrence(overrides: Partial<ScheduleOccurrenceView> = {}): ScheduleOccurrenceView {
  return {
    scheduleId: 'schedule-a',
    scheduleCategory: 'time',
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
    expect(screen.getByText('14:00')).toBeTruthy();
    expect(screen.getByText('15:00')).toBeTruthy();
    expect(screen.queryByText(/至 /)).toBeNull();
    expect(screen.queryByText('重复')).toBeNull();
    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-occurrence-indicator').props.style),
    ).toMatchObject({
      backgroundColor: colors.focus,
      height: 10,
      width: 10,
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-occurrence-card').props.style),
    ).toMatchObject({
      backgroundColor: colors.surface,
      minHeight: 72,
    });
  });

  it('keeps the same card height for different durations', () => {
    const short = render(
      <ScheduleOccurrenceRow item={occurrence({ occurrenceEnd: '2026-08-13T06:30:00.000Z' })} />,
    );
    const long = render(
      <ScheduleOccurrenceRow item={occurrence({ occurrenceEnd: '2026-08-13T09:00:00.000Z' })} />,
    );

    expect(
      StyleSheet.flatten(short.getByTestId('schedule-occurrence-card').props.style).minHeight,
    ).toBe(StyleSheet.flatten(long.getByTestId('schedule-occurrence-card').props.style).minHeight);
  });

  it('shows a recurrence badge for a recurring schedule', () => {
    render(<ScheduleOccurrenceRow item={occurrence({ recurrenceMode: 'recurring' })} />);

    expect(screen.getByText('重复')).toBeTruthy();
  });

  it('extends the timeline rail when another occurrence follows', () => {
    render(<ScheduleOccurrenceRow isLast={false} item={occurrence()} />);

    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-occurrence-row').props.style),
    ).toMatchObject({ paddingBottom: 10 });
  });

  it('omits meta when a one-time schedule has no location', () => {
    render(<ScheduleOccurrenceRow item={occurrence({ locationName: null })} />);

    expect(screen.queryByText('上海科技馆')).toBeNull();
    expect(screen.queryByText('重复')).toBeNull();
  });

  it('shows repeating without a location line', () => {
    render(
      <ScheduleOccurrenceRow
        item={occurrence({ locationName: null, recurrenceMode: 'recurring' })}
      />,
    );

    expect(screen.getByText('重复')).toBeTruthy();
    expect(screen.queryByText('上海科技馆')).toBeNull();
  });

  it('hides the end time when a timed occurrence has no end', () => {
    render(<ScheduleOccurrenceRow item={occurrence({ occurrenceEnd: null })} />);

    expect(screen.getByText('14:00')).toBeTruthy();
    expect(screen.queryByText('15:00')).toBeNull();
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
    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-occurrence-indicator').props.style),
    ).toMatchObject({
      backgroundColor: colors.text,
      height: 10,
      width: 10,
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-occurrence-card').props.style),
    ).toMatchObject({
      backgroundColor: colors.surface,
      minHeight: 72,
    });
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

    expect(screen.queryByText('位置日程')).toBeNull();
    expect(screen.getByText('到公司提醒我打卡')).toBeTruthy();
    expect(screen.getByText('公司')).toBeTruthy();
    expect(screen.queryByText('location')).toBeNull();
    expect(screen.queryByText('arrive_location')).toBeNull();
    expect(screen.queryByText('high')).toBeNull();
    expect(screen.queryByText('strong')).toBeNull();
  });
});
