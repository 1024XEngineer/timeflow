import { fireEvent, render, screen } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';
import { Modal, ScrollView, StyleSheet } from 'react-native';

import type {
  LocationScheduleView,
  ScheduleOccurrenceView,
} from '../../../../../src/features/schedule/application';
import { LocationScheduleDetailSheet } from '../../../../../src/features/schedule/presentation/LocationScheduleDetailSheet';
import { ScheduleOccurrenceDetailSheet } from '../../../../../src/features/schedule/presentation/ScheduleOccurrenceDetailSheet';

let mockBottomInset = 0;

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockBottomInset, left: 0, right: 0, top: 0 }),
}));

const timedOccurrence: ScheduleOccurrenceView = {
  scheduleId: 'schedule-a',
  scheduleCategory: 'time',
  category: 'work',
  recurrenceMode: 'recurring',
  title: '与产品团队确认下一阶段的发布计划和风险清单',
  isAllDay: false,
  timezone: 'Asia/Shanghai',
  locationName: '远程会议室 A',
  reminderType: 'before_start',
  reminderStrength: 'medium',
  occurrenceStart: '2026-08-13T01:30:00.000Z',
  occurrenceEnd: '2026-08-13T02:45:00.000Z',
};

const allDayOccurrence: ScheduleOccurrenceView = {
  scheduleId: 'all-day-a',
  scheduleCategory: 'time',
  category: null,
  recurrenceMode: 'once',
  title: '公司休息日',
  isAllDay: true,
  timezone: 'Asia/Shanghai',
  locationName: null,
  reminderType: null,
  reminderStrength: null,
  occurrenceStart: '2026-08-16T16:00:00.000Z',
  occurrenceEnd: '2026-08-17T16:00:00.000Z',
};

describe('schedule detail sheets', () => {
  it('keeps detail content above the system navigation area', () => {
    mockBottomInset = 34;
    render(<ScheduleOccurrenceDetailSheet occurrence={timedOccurrence} onClose={() => {}} />);

    const content = screen.getByTestId('schedule-detail-content');
    expect(StyleSheet.flatten(content.props.contentContainerStyle)).toMatchObject({
      paddingBottom: 50,
    });
    mockBottomInset = 0;
  });

  it('prioritizes occurrence date and time while retaining optional information', () => {
    render(<ScheduleOccurrenceDetailSheet occurrence={timedOccurrence} onClose={() => {}} />);

    expect(screen.getByText(timedOccurrence.title)).toBeTruthy();
    expect(screen.getByText('工作')).toBeTruthy();
    expect(screen.getByText('分类')).toBeTruthy();
    expect(screen.queryByText('时间日程')).toBeNull();
    expect(screen.queryByText('周期日程')).toBeNull();
    expect(screen.getByText('2026年8月13日')).toBeTruthy();
    expect(screen.getByText('星期四')).toBeTruthy();
    expect(screen.getByText('09:30')).toBeTruthy();
    expect(screen.getByText('10:45')).toBeTruthy();
    expect(screen.queryByText('8月13日')).toBeNull();
    expect(screen.getByText('远程会议室 A')).toBeTruthy();
    expect(screen.getByText('日程开始前')).toBeTruthy();
    expect(screen.getByText('提醒强度 · 标准提醒')).toBeTruthy();
    expect(screen.getByText('时区 · Asia/Shanghai')).toBeTruthy();
    expect(screen.queryByText('全天')).toBeNull();
  });

  it('shows all-day status without empty location or reminder sections', () => {
    render(<ScheduleOccurrenceDetailSheet occurrence={allDayOccurrence} onClose={() => {}} />);

    expect(screen.getByText('2026年8月17日')).toBeTruthy();
    expect(screen.queryByText('一次性')).toBeNull();
    expect(screen.getByText('全天')).toBeTruthy();
    expect(screen.queryByText('地点')).toBeNull();
    expect(screen.queryByText('提醒')).toBeNull();
    expect(screen.queryByText('工作')).toBeNull();
    expect(screen.queryByText('其他')).toBeNull();
  });

  it('adds local dates to start and end times when an occurrence crosses midnight', () => {
    render(
      <ScheduleOccurrenceDetailSheet
        occurrence={{
          ...timedOccurrence,
          occurrenceStart: '2026-08-13T15:00:00.000Z',
          occurrenceEnd: '2026-08-13T17:00:00.000Z',
          recurrenceMode: 'once',
          title: '跨日维护窗口',
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('8月13日')).toBeTruthy();
    expect(screen.getByText('23:00')).toBeTruthy();
    expect(screen.getByText('8月14日')).toBeTruthy();
    expect(screen.getByText('01:00')).toBeTruthy();
  });

  it('keeps the modal mounted while toggling visibility for the slide-out animation', () => {
    const view = render(
      <ScheduleOccurrenceDetailSheet occurrence={timedOccurrence} onClose={() => {}} />,
    );
    expect(view.UNSAFE_getByType(Modal).props.visible).toBe(true);

    view.rerender(<ScheduleOccurrenceDetailSheet occurrence={null} onClose={() => {}} />);
    expect(view.UNSAFE_getByType(Modal).props.visible).toBe(false);
  });

  it('hides unconfigured location fields and keeps the close callback', () => {
    const onClose = jest.fn();
    const schedule: LocationScheduleView = {
      scheduleId: 'location-a',
      scheduleCategory: 'location',
      category: 'study',
      title: '地点触发日程',
      timezone: 'Asia/Shanghai',
      locationName: null,
      reminderType: null,
      reminderStrength: null,
    };
    render(<LocationScheduleDetailSheet onClose={onClose} schedule={schedule} />);

    expect(screen.getByText('地点触发日程')).toBeTruthy();
    expect(screen.getByText('学习')).toBeTruthy();
    expect(screen.getByText('分类')).toBeTruthy();
    expect(screen.queryByText('地点日程')).toBeNull();
    expect(screen.queryByText('未命名地点')).toBeNull();
    expect(screen.queryByText('未配置')).toBeNull();
    expect(screen.queryByText('地点')).toBeNull();
    expect(screen.queryByText('提醒')).toBeNull();
    fireEvent.press(screen.getByLabelText('关闭详情'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
