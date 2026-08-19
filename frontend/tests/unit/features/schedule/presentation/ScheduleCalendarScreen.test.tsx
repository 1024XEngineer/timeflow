import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';

import type {
  ScheduleCalendarReadService,
  ScheduleOccurrenceView,
} from '../../../../../src/features/schedule/application';
import { ScheduleCalendarScreen } from '../../../../../src/features/schedule/presentation/ScheduleCalendarScreen';

function occurrenceOnSelectedDay(
  hourUtc: number,
  overrides: Partial<ScheduleOccurrenceView> = {},
): ScheduleOccurrenceView {
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), hourUtc, 0, 0));
  return {
    scheduleId: 'schedule-a',
    scheduleCategory: 'time',
    recurrenceMode: 'once',
    title: '项目例会',
    isAllDay: false,
    timezone: 'Asia/Shanghai',
    locationName: null,
    reminderType: 'before_start',
    reminderStrength: 'medium',
    occurrenceStart: start.toISOString(),
    occurrenceEnd: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function createService(
  occurrences: readonly ScheduleOccurrenceView[] = [],
): ScheduleCalendarReadService {
  return {
    getSchedulesByDay: jest
      .fn<ScheduleCalendarReadService['getSchedulesByDay']>()
      .mockResolvedValue([]),
    getSchedulesByRange: jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockResolvedValue(occurrences),
    getLocationSchedules: jest
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
      ]),
  };
}

describe('ScheduleCalendarScreen location schedules', () => {
  it('keeps accountId in the calendar data flow without rendering it', async () => {
    const service = createService();
    const accountId = 'internal-account-id-not-for-display';
    render(
      <ScheduleCalendarScreen
        accountId={accountId}
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(service.getSchedulesByRange).toHaveBeenCalled());
    expect(service.getSchedulesByRange).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }),
    );
    expect(service.getLocationSchedules).toHaveBeenCalledWith({ accountId });
    expect(screen.queryByText(accountId)).toBeNull();
  });

  it('reloads calendar queries when refreshSignal changes', async () => {
    const service = createService();
    const props = {
      accountId: 'account-a',
      onSignOut: () => {},
      service,
      timezone: 'Asia/Shanghai',
      username: 'Sarah',
    };
    const view = render(<ScheduleCalendarScreen {...props} refreshSignal={0} />);

    await waitFor(() => expect(service.getSchedulesByRange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(service.getLocationSchedules).toHaveBeenCalledTimes(1));

    view.rerender(<ScheduleCalendarScreen {...props} refreshSignal={1} />);

    await waitFor(() => expect(service.getSchedulesByRange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(service.getLocationSchedules).toHaveBeenCalledTimes(2));
    expect(service.getSchedulesByRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: 'account-a' }),
    );
    expect(service.getLocationSchedules).toHaveBeenLastCalledWith({ accountId: 'account-a' });
  });

  it('renders compact account controls, truncates a long username, and signs out', async () => {
    const service = createService();
    const onSignOut = jest.fn<() => void>();
    const username = 'zhangsan-with-an-extremely-long-account-name';
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onSignOut={onSignOut}
        service={service}
        timezone="Asia/Shanghai"
        username={username}
      />,
    );

    await waitFor(() => expect(service.getSchedulesByRange).toHaveBeenCalled());
    expect(screen.queryByText('我的日程')).toBeNull();
    expect(screen.getByText('Z')).toBeTruthy();
    expect(screen.getByText(username)).toBeTruthy();
    expect(screen.queryByText(/账号：/)).toBeNull();
    expect(screen.getByTestId('schedule-account-username').props).toMatchObject({
      ellipsizeMode: 'tail',
      numberOfLines: 1,
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-account-username').props.style),
    ).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(
      StyleSheet.flatten(screen.getByTestId('schedule-account-actions').props.style),
    ).toMatchObject({ marginLeft: 'auto', maxWidth: 240, minWidth: 0 });

    fireEvent.press(screen.getByRole('button', { name: '退出登录' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('shows a location section that stays visible after selecting a day and changing month', async () => {
    const service = createService();
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(screen.getByText('地点提醒')).toBeTruthy());
    expect(screen.queryByText('位置触发')).toBeNull();
    expect(screen.getByText('今日安排')).toBeTruthy();
    expect(screen.queryByText('当日安排')).toBeNull();
    expect(screen.getByText('留一点时间给自己，或用语音助手添加安排。')).toBeTruthy();
    expect(screen.getByText('到公司提醒我打卡')).toBeTruthy();

    const dateButton = screen.getByLabelText(/月13日$/);
    fireEvent.press(dateButton);
    const today = new Date();
    const selectedIsPast = 13 < today.getDate();
    if (today.getDate() === 13) {
      expect(screen.getByText('今日安排')).toBeTruthy();
      expect(screen.getByText('留一点时间给自己，或用语音助手添加安排。')).toBeTruthy();
    } else {
      expect(screen.getByText(`${today.getMonth() + 1}月13日的安排`)).toBeTruthy();
      expect(screen.queryByText('今日安排')).toBeNull();
      if (selectedIsPast) {
        expect(screen.queryByText('留一点时间给自己，或用语音助手添加安排。')).toBeNull();
        expect(screen.getByText('这一天是属于你的')).toBeTruthy();
      } else {
        expect(screen.getByText('留一点时间给自己，或用语音助手添加安排。')).toBeTruthy();
      }
    }
    expect(screen.getByText('地点提醒')).toBeTruthy();
    const rangeCallsBeforeMonthChange = (service.getSchedulesByRange as jest.Mock).mock.calls
      .length;

    fireEvent.press(screen.getByLabelText('下个月'));
    await waitFor(() =>
      expect(service.getSchedulesByRange).toHaveBeenCalledTimes(rangeCallsBeforeMonthChange + 1),
    );
    expect(screen.getByText('地点提醒')).toBeTruthy();
    expect(service.getLocationSchedules).toHaveBeenCalledTimes(1);
  });

  it('opens a read-only location detail with the configured fields', async () => {
    const service = createService();
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(screen.getByLabelText('公司 到公司提醒我打卡')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('公司 到公司提醒我打卡'));

    expect(screen.queryByText('地点日程')).toBeNull();
    expect(screen.getAllByText('公司')).toHaveLength(2);
    expect(screen.getByText('时区 · Asia/Shanghai')).toBeTruthy();
    expect(screen.getByText('到达地点时')).toBeTruthy();
    expect(screen.getByText('提醒强度 · 强提醒')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
    expect(screen.queryByText('删除')).toBeNull();
  });

  it('connects multiple timed occurrences on a timeline and opens detail', async () => {
    const first = occurrenceOnSelectedDay(1, { scheduleId: 'schedule-a', title: '项目例会' });
    const second = occurrenceOnSelectedDay(4, { scheduleId: 'schedule-b', title: '方案讨论' });
    const service = createService([first, second]);

    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(screen.getByText('项目例会')).toBeTruthy());
    expect(screen.getByText('方案讨论')).toBeTruthy();
    expect(screen.getByText('2 项')).toBeTruthy();
    expect(
      StyleSheet.flatten(screen.getAllByTestId('schedule-occurrence-row')[0]?.props.style),
    ).toMatchObject({ paddingBottom: 10 });

    fireEvent.press(screen.getByLabelText(/项目例会$/));
    expect(screen.getByText('时区 · Asia/Shanghai')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('关闭详情'));
    await waitFor(() => expect(screen.queryByText('时区 · Asia/Shanghai')).toBeNull());
  });
});
