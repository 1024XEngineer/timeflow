import { fireEvent, render, screen } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type {
  LocationScheduleView,
  ScheduleOccurrenceView,
} from '../../../../../src/features/schedule/application';
import { LocationScheduleDetailSheet } from '../../../../../src/features/schedule/presentation/LocationScheduleDetailSheet';
import { ScheduleOccurrenceDetailSheet } from '../../../../../src/features/schedule/presentation/ScheduleOccurrenceDetailSheet';

const timedOccurrence: ScheduleOccurrenceView = {
  scheduleId: 'schedule-a',
  scheduleCategory: 'time',
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

describe('schedule detail sheets', () => {
  it('prioritizes occurrence date and time while retaining optional information', () => {
    render(<ScheduleOccurrenceDetailSheet occurrence={timedOccurrence} onClose={() => {}} />);

    expect(screen.getByText(timedOccurrence.title)).toBeTruthy();
    expect(screen.getByText('时间日程')).toBeTruthy();
    expect(screen.getByText('周期日程')).toBeTruthy();
    expect(screen.getByText('2026年8月13日')).toBeTruthy();
    expect(screen.getByText('星期四')).toBeTruthy();
    expect(screen.getByText('09:30')).toBeTruthy();
    expect(screen.getByText('10:45')).toBeTruthy();
    expect(screen.getByText('远程会议室 A')).toBeTruthy();
    expect(screen.getByText('日程开始前')).toBeTruthy();
    expect(screen.getByText('提醒强度 · 标准提醒')).toBeTruthy();
    expect(screen.getByText('时区 · Asia/Shanghai')).toBeTruthy();
    expect(screen.queryByText('全天')).toBeNull();
  });

  it('shows all-day status without empty location or reminder sections', () => {
    render(
      <ScheduleOccurrenceDetailSheet
        occurrence={{
          ...timedOccurrence,
          isAllDay: true,
          locationName: '   ',
          recurrenceMode: 'once',
          reminderStrength: null,
          reminderType: null,
          title: '公司休息日',
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('一次性')).toBeTruthy();
    expect(screen.getAllByText('全天')).toHaveLength(2);
    expect(screen.queryByText('地点')).toBeNull();
    expect(screen.queryByText('提醒')).toBeNull();
  });

  it('hides unconfigured location fields and keeps the close callback', () => {
    const onClose = jest.fn();
    const schedule: LocationScheduleView = {
      scheduleId: 'location-a',
      scheduleCategory: 'location',
      title: '地点触发日程',
      timezone: 'Asia/Shanghai',
      locationName: null,
      reminderType: null,
      reminderStrength: null,
    };
    render(<LocationScheduleDetailSheet onClose={onClose} schedule={schedule} />);

    expect(screen.getByText('地点日程')).toBeTruthy();
    expect(screen.queryByText('未命名地点')).toBeNull();
    expect(screen.queryByText('未配置')).toBeNull();
    expect(screen.queryByText('地点')).toBeNull();
    expect(screen.queryByText('提醒')).toBeNull();
    fireEvent.press(screen.getByLabelText('关闭详情'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
