import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { StandardCreateSheet } from '@/features/schedule/editor/StandardCreateSheet';
import type { ScheduleUpsertPayload as ScheduleDraft } from '@/contracts';

function pressPrimaryAction(label: string) {
  const matches = screen.getAllByText(label);
  fireEvent.press(matches[matches.length - 1]!);
}

describe('StandardCreateSheet', () => {
  const baseProps = {
    onClose: jest.fn(),
    onSave: jest.fn(async (_draft: ScheduleDraft) => undefined),
    onUpsertLocation: jest.fn(),
    savedLocations: [] as [],
  };

  it('rejects an empty title', async () => {
    render(<StandardCreateSheet {...baseProps} />);
    pressPrimaryAction('添加日程');
    expect(await screen.findByText('请填写日程标题。')).toBeTruthy();
    expect(baseProps.onSave).not.toHaveBeenCalled();
  });

  it('creates a time schedule with a future start', async () => {
    const onSave = jest.fn(async (_draft: ScheduleDraft) => undefined);

    render(<StandardCreateSheet {...baseProps} onSave={onSave} />);
    fireEvent.changeText(screen.getByPlaceholderText('请输入日程标题'), '项目评审');
    pressPrimaryAction('添加日程');

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const draft = onSave.mock.calls[0]![0];
    expect(draft.title).toBe('项目评审');
    expect(draft.schedule_type).toBe('time');
    expect(draft.start_time).toBeTruthy();
  });

  it('rejects a start time that is not in the future', async () => {
    const past = new Date(Date.now() - 120_000);
    render(
      <StandardCreateSheet
        {...baseProps}
        initialDraft={{
          source_mode: 'manual',
          schedule_type: 'time',
          title: '过去',
          start_time: past.toISOString(),
          end_time: null,
          schedule_id: 'schedule_past',
        }}
      />,
    );
    pressPrimaryAction('保存修改');
    expect(await screen.findByText('开始时间需晚于当前分钟，请选择下一分钟及以后。')).toBeTruthy();
  });

  it('surfaces save errors from onSave', async () => {
    const onSave = jest.fn(async () => {
      throw new Error('网络异常');
    });
    render(<StandardCreateSheet {...baseProps} onSave={onSave} />);
    fireEvent.changeText(screen.getByPlaceholderText('请输入日程标题'), '会失败');
    pressPrimaryAction('添加日程');
    expect(await screen.findByText('网络异常')).toBeTruthy();
  });

  it('surfaces non-Error save failures', async () => {
    const onSave = jest.fn(async () => {
      throw 'boom';
    });
    render(<StandardCreateSheet {...baseProps} onSave={onSave} />);
    fireEvent.changeText(screen.getByPlaceholderText('请输入日程标题'), '会失败');
    pressPrimaryAction('添加日程');
    expect(await screen.findByText('保存失败，请稍后重试。')).toBeTruthy();
  });

  it('saves a location-only schedule', async () => {
    const onSave = jest.fn(async (_draft: ScheduleDraft) => undefined);
    const location = {
      id: 'loc_1',
      address: '南京东路1号',
      latitude: 31.2,
      longitude: 121.5,
      name: '办公室',
    };
    render(
      <StandardCreateSheet
        {...baseProps}
        onSave={onSave}
        savedLocations={[location]}
        initialDraft={{
          source_mode: 'manual',
          schedule_type: 'location',
          title: '到公司',
          start_time: null,
          end_time: null,
          latitude: 31.2,
          longitude: 121.5,
          location_name: '办公室',
          location_address: '南京东路1号',
          geofence_radius_meters: 100,
          time_remind_offset_minutes: 0,
        }}
      />,
    );
    // Clearing the date also clears start/end, so the schedule becomes location-only.
    fireEvent.press(screen.getByLabelText('清除日期'));
    pressPrimaryAction('添加日程');
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0].schedule_type).toBe('location');
  });

  it('rejects end time earlier than start', async () => {
    const future = new Date(Date.now() + 3_600_000);
    const later = new Date(Date.now() + 7_200_000);
    render(
      <StandardCreateSheet
        {...baseProps}
        initialDraft={{
          source_mode: 'manual',
          schedule_type: 'time',
          title: '校验',
          start_time: later.toISOString(),
          end_time: future.toISOString(),
          time_remind_offset_minutes: 0,
          schedule_id: 'schedule_more',
        }}
      />,
    );
    pressPrimaryAction('保存修改');
    expect(await screen.findByText('结束时间不能早于开始时间。')).toBeTruthy();
  });

  it('rejects a negative remind offset', async () => {
    const future = new Date(Date.now() + 3_600_000);
    render(
      <StandardCreateSheet
        {...baseProps}
        initialDraft={{
          source_mode: 'manual',
          schedule_type: 'time',
          title: '校验提醒',
          start_time: future.toISOString(),
          end_time: null,
          time_remind_offset_minutes: 5,
          schedule_id: 'schedule_offset',
        }}
      />,
    );
    fireEvent.changeText(screen.getByLabelText('提前提醒分钟数'), '-1');
    pressPrimaryAction('保存修改');
    expect(await screen.findByText('提前提醒分钟数必须是非负整数。')).toBeTruthy();
  });

  it('rejects invalid geofence radius for location schedules', async () => {
    render(
      <StandardCreateSheet
        {...baseProps}
        savedLocations={[
          {
            id: 'loc_1',
            address: '南京东路1号',
            latitude: 31.2,
            longitude: 121.5,
            name: '办公室',
          },
        ]}
        initialDraft={{
          source_mode: 'manual',
          schedule_type: 'location',
          title: '到公司',
          start_time: null,
          latitude: 31.2,
          longitude: 121.5,
          location_name: '办公室',
          location_address: '南京东路1号',
          geofence_radius_meters: 50,
          time_remind_offset_minutes: 0,
        }}
      />,
    );
    fireEvent.press(screen.getByLabelText('清除日期'));
    fireEvent.changeText(screen.getByLabelText('地理围栏半径'), '0');
    pressPrimaryAction('添加日程');
    expect(await screen.findByText('地理围栏半径必须是大于 0 的整数。')).toBeTruthy();
  });
});
