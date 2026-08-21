import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Platform, StyleSheet } from 'react-native';

import type {
  ScheduleCalendarReadService,
  ScheduleOccurrenceView,
} from '../../../../../src/features/schedule/application';
import { ScheduleCalendarScreen } from '../../../../../src/features/schedule/presentation/ScheduleCalendarScreen';

let mockBottomInset = 0;
let mockTopInset = 0;

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: mockBottomInset, left: 0, right: 0, top: mockTopInset }),
}));

function occurrenceOnSelectedDay(
  hourUtc: number,
  overrides: Partial<ScheduleOccurrenceView> = {},
): ScheduleOccurrenceView {
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), hourUtc, 0, 0));
  return {
    scheduleId: 'schedule-a',
    scheduleCategory: 'time',
    category: null,
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
  beforeEach(() => {
    Platform.OS = 'ios';
  });

  afterEach(() => {
    jest.useRealTimers();
    mockBottomInset = 0;
    mockTopInset = 0;
    Platform.OS = 'ios';
  });

  it('leaves enough scroll space for the floating voice controls and system navigation, and keeps the last occurrence reachable', async () => {
    mockBottomInset = 34;
    const service = createService();
    // 补上真正渲染出来的最后一项日程，不能只断言算出来的 padding 数字——
    // 那个数字本身不能证明这一项没被浮动语音条挡住、还是可以点开的。
    // selectedOccurrences 来自 getSchedulesByRange（不是 getSchedulesByDay），
    // 按当前选中日期在客户端分组，所以要选到日程所在的那一天才会渲染出来。
    (
      service.getSchedulesByRange as jest.MockedFunction<
        ScheduleCalendarReadService['getSchedulesByRange']
      >
    ).mockResolvedValue([
      {
        scheduleId: 'schedule-last',
        scheduleCategory: 'time',
        category: null,
        recurrenceMode: 'once',
        title: '当日最后一条日程',
        isAllDay: false,
        timezone: 'Asia/Shanghai',
        locationName: null,
        reminderType: null,
        reminderStrength: null,
        occurrenceStart: '2026-08-13T09:00:00.000Z',
        occurrenceEnd: '2026-08-13T10:00:00.000Z',
      },
    ]);
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onOpenPermissions={() => {}}
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(service.getLocationSchedules).toHaveBeenCalled());
    expect(
      StyleSheet.flatten(
        screen.getByTestId('schedule-calendar-scroll').props.contentContainerStyle,
      ),
    ).toMatchObject({ paddingBottom: 118, paddingTop: 0 });

    fireEvent.press(screen.getByLabelText(/月13日$/));
    const lastRow = await screen.findByLabelText(/当日最后一条日程$/);
    fireEvent.press(lastRow);
    // 点开之后详情抽屉真的弹出来了，证明这一行不只是渲染出来、还真的可以点击响应，
    // 不是被浮动语音条盖住了个摆设。
    expect(screen.getByText('日程详情')).toBeTruthy();
  });

  it('avoids the Android status bar in edge-to-edge mode', async () => {
    Platform.OS = 'android';
    mockTopInset = 24;
    const service = createService();
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onOpenPermissions={() => {}}
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(service.getLocationSchedules).toHaveBeenCalled());
    expect(
      StyleSheet.flatten(
        screen.getByTestId('schedule-calendar-scroll').props.contentContainerStyle,
      ),
    ).toMatchObject({ paddingTop: 24 });
  });

  it('leaves iOS to its own automatic safe-area adjustment instead of double-padding the top', async () => {
    Platform.OS = 'ios';
    mockTopInset = 44;
    const service = createService();
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onOpenPermissions={() => {}}
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(service.getLocationSchedules).toHaveBeenCalled());
    expect(
      StyleSheet.flatten(
        screen.getByTestId('schedule-calendar-scroll').props.contentContainerStyle,
      ),
    ).toMatchObject({ paddingTop: 0 });
  });

  it('keeps accountId in the calendar data flow without rendering it', async () => {
    const service = createService();
    const accountId = 'internal-account-id-not-for-display';
    render(
      <ScheduleCalendarScreen
        accountId={accountId}
        onOpenPermissions={() => {}}
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
      onOpenPermissions: () => {},
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
        onOpenPermissions={() => {}}
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

  it('opens permissions when the user pill is pressed', async () => {
    const service = createService();
    const onOpenPermissions = jest.fn();
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onOpenPermissions={onOpenPermissions}
        onSignOut={() => {}}
        service={service}
        timezone="Asia/Shanghai"
        username="Sarah"
      />,
    );

    await waitFor(() => expect(service.getSchedulesByRange).toHaveBeenCalled());
    fireEvent.press(screen.getByLabelText('当前用户 Sarah，点击查看权限设置'));

    expect(onOpenPermissions).toHaveBeenCalledTimes(1);
  });

  it('shows a location section that stays visible after selecting a day and changing month', async () => {
    const service = createService();
    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onOpenPermissions={() => {}}
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
        onOpenPermissions={() => {}}
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
    // 冻结时钟：组件内部 useScheduleCalendar 会在 render 时自己再调一次 new Date()
    // 来定 selectedDate，若不冻结，测试这里取的 now 和渲染时取的 now 理论上可能
    // 跨越本地午夜而不一致。冻结后两边的 new Date() 都返回同一个瞬间。
    const now = new Date();
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'queueMicrotask',
        'nextTick',
      ],
    });
    jest.setSystemTime(now);
    // 用 selectedDate 所在的日历日（本地取值，与组件默认 selectedDate 的算法一致）
    // 加显式 +08:00 偏移锚定，避免真实 UTC 时刻落在 16:00-24:00 时 Shanghai 已跨入
    // 下一天、而 selectedDate 仍是当天，导致注入的日程被分到未选中的那一天。
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const occurrenceStart = new Date(`${todayKey}T12:00:00+08:00`).toISOString();
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
      onOpenPermissions: () => {},
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
    await waitFor(() => expect(screen.getAllByText('工作')).toHaveLength(1));
    expect(screen.getByText('分类')).toBeTruthy();
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
      onOpenPermissions: () => {},
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
    await waitFor(() => expect(screen.getAllByText('学习')).toHaveLength(1));
    expect(screen.getByText('分类')).toBeTruthy();
    expect(screen.getByText('日程详情')).toBeTruthy();
  });

  it('connects multiple timed occurrences on a timeline and opens detail', async () => {
    const first = occurrenceOnSelectedDay(1, { scheduleId: 'schedule-a', title: '项目例会' });
    const second = occurrenceOnSelectedDay(4, { scheduleId: 'schedule-b', title: '方案讨论' });
    const service = createService([first, second]);

    render(
      <ScheduleCalendarScreen
        accountId="account-a"
        onOpenPermissions={() => {}}
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
