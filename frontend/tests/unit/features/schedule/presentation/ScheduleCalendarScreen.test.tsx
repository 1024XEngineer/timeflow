import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';
import { StyleSheet } from 'react-native';

import type { ScheduleCalendarReadService } from '../../../../../src/features/schedule/application';
import { ScheduleCalendarScreen } from '../../../../../src/features/schedule/presentation/ScheduleCalendarScreen';

function createService(): ScheduleCalendarReadService {
  return {
    getSchedulesByDay: jest
      .fn<ScheduleCalendarReadService['getSchedulesByDay']>()
      .mockResolvedValue([]),
    getSchedulesByRange: jest
      .fn<ScheduleCalendarReadService['getSchedulesByRange']>()
      .mockResolvedValue([]),
    getLocationSchedules: jest
      .fn<ScheduleCalendarReadService['getLocationSchedules']>()
      .mockResolvedValue([
        {
          scheduleId: 'location-a',
          scheduleCategory: 'location',
          category: 'work',
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
    expect(screen.getByText('我的日程')).toBeTruthy();
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
    ).toMatchObject({ maxWidth: 240, minWidth: 0 });

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
    expect(screen.getByText('到公司提醒我打卡')).toBeTruthy();

    const dateButton = screen.getByLabelText(/月13日$/);
    fireEvent.press(dateButton);
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

    expect(screen.getByText('地点日程')).toBeTruthy();
    expect(screen.getAllByText('公司')).toHaveLength(2);
    expect(screen.getByText('时区 · Asia/Shanghai')).toBeTruthy();
    expect(screen.getByText('到达地点时')).toBeTruthy();
    expect(screen.getByText('提醒强度 · 强提醒')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
    expect(screen.queryByText('删除')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByText('日程详情')).toBeNull();
  });

  it('updates an open occurrence detail after an asynchronous category refresh', async () => {
    const service = createService();
    (
      service.getLocationSchedules as jest.MockedFunction<
        ScheduleCalendarReadService['getLocationSchedules']
      >
    ).mockResolvedValue([]);
    const occurrenceStart = new Date().toISOString();
    const initialOccurrence = {
      scheduleId: 'time-a',
      scheduleCategory: 'time' as const,
      category: null,
      recurrenceMode: 'once' as const,
      title: '异步分类日程',
      isAllDay: false,
      timezone: 'Asia/Shanghai',
      locationName: null,
      reminderType: null,
      reminderStrength: null,
      occurrenceStart,
      occurrenceEnd: null,
    };
    const getSchedulesByRange = service.getSchedulesByRange as jest.MockedFunction<
      ScheduleCalendarReadService['getSchedulesByRange']
    >;
    getSchedulesByRange
      .mockReset()
      .mockResolvedValueOnce([initialOccurrence])
      .mockResolvedValueOnce([{ ...initialOccurrence, category: 'work' }]);
    const props = {
      accountId: 'account-a',
      onSignOut: () => {},
      service,
      timezone: 'Asia/Shanghai',
      username: 'Sarah',
    };
    const view = render(<ScheduleCalendarScreen {...props} refreshSignal={0} />);

    await waitFor(() => expect(screen.getByText('异步分类日程')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: /异步分类日程/ }));
    expect(screen.getByText('日程详情')).toBeTruthy();
    expect(screen.queryByText('工作')).toBeNull();

    view.rerender(<ScheduleCalendarScreen {...props} refreshSignal={1} />);

    await waitFor(() => expect(getSchedulesByRange).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('工作')).toHaveLength(2));
    expect(screen.getByText('日程详情')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByText('日程详情')).toBeNull();
  });

  it('updates an open location detail after an asynchronous category refresh', async () => {
    const service = createService();
    const initialLocation = {
      scheduleId: 'location-a',
      scheduleCategory: 'location' as const,
      category: null,
      title: '到公司提醒我打卡',
      timezone: 'Asia/Shanghai',
      locationName: '公司',
      reminderType: 'arrive_location' as const,
      reminderStrength: 'high' as const,
    };
    const getLocationSchedules = service.getLocationSchedules as jest.MockedFunction<
      ScheduleCalendarReadService['getLocationSchedules']
    >;
    getLocationSchedules
      .mockReset()
      .mockResolvedValueOnce([initialLocation])
      .mockResolvedValueOnce([{ ...initialLocation, category: 'study' }]);
    const props = {
      accountId: 'account-a',
      onSignOut: () => {},
      service,
      timezone: 'Asia/Shanghai',
      username: 'Sarah',
    };
    const view = render(<ScheduleCalendarScreen {...props} refreshSignal={0} />);

    await waitFor(() => expect(screen.getByLabelText('公司 到公司提醒我打卡')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('公司 到公司提醒我打卡'));
    expect(screen.getByText('日程详情')).toBeTruthy();
    expect(screen.queryByText('学习')).toBeNull();

    view.rerender(<ScheduleCalendarScreen {...props} refreshSignal={1} />);

    await waitFor(() => expect(getLocationSchedules).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('学习')).toHaveLength(2));
    expect(screen.getByText('日程详情')).toBeTruthy();
  });
});
