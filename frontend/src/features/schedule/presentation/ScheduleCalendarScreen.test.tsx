import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { describe, expect, it, jest } from '@jest/globals';

import type { ScheduleCalendarReadService } from '../application';
import { ScheduleCalendarScreen } from './ScheduleCalendarScreen';

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
  it('shows a location section that stays visible after selecting a day and changing month', async () => {
    const service = createService();
    render(
      <ScheduleCalendarScreen accountId="account-a" service={service} timezone="Asia/Shanghai" />,
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
      <ScheduleCalendarScreen accountId="account-a" service={service} timezone="Asia/Shanghai" />,
    );

    await waitFor(() => expect(screen.getByLabelText('公司 到公司提醒我打卡')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('公司 到公司提醒我打卡'));

    expect(screen.getByText('地点日程')).toBeTruthy();
    expect(screen.getAllByText('公司')).toHaveLength(2);
    expect(screen.getByText('Asia/Shanghai')).toBeTruthy();
    expect(screen.getByText('arrive_location')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
    expect(screen.queryByText('删除')).toBeNull();
  });
});
