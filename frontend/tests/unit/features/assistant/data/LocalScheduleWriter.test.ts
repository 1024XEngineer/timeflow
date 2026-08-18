import { describe, expect, it, jest } from '@jest/globals';

import type { ScheduleLocalRepository } from '../../../../../src/features/schedule/data';
import { LocalScheduleWriter } from '../../../../../src/features/assistant/data/local/LocalScheduleWriter';

describe('LocalScheduleWriter', () => {
  it('preserves category from a WebSocket command result', async () => {
    const applyCloudSchedule = jest.fn(async () => true);
    const repository = { applyCloudSchedule } as unknown as ScheduleLocalRepository;
    const writer = new LocalScheduleWriter(repository);

    await writer.applyCommandResult('account-a', {
      operation: 'create_schedule',
      status: 'applied',
      schedule: {
        id: 'schedule-a',
        schedule_type: 'time',
        schedule_kind: 'once',
        category: 'study',
        title: '学习 Go',
        timezone: 'Asia/Shanghai',
        start_time: '2026-08-17T12:00:00Z',
      },
    });

    expect(applyCloudSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'account-a',
        category: 'study',
        id: 'schedule-a',
      }),
    );
  });

  it('preserves an unclassified legacy command result as null', async () => {
    const applyCloudSchedule = jest.fn(async () => true);
    const repository = { applyCloudSchedule } as unknown as ScheduleLocalRepository;
    const writer = new LocalScheduleWriter(repository);

    await writer.applyCommandResult('account-a', {
      operation: 'create_schedule',
      status: 'applied',
      schedule: {
        id: 'schedule-a',
        schedule_type: 'time',
        schedule_kind: 'once',
        title: 'Legacy',
        timezone: 'Asia/Shanghai',
      },
    });

    expect(applyCloudSchedule).toHaveBeenCalledWith(expect.objectContaining({ category: null }));
  });

  it('rejects an unsupported category before local persistence', async () => {
    const applyCloudSchedule = jest.fn(async () => true);
    const repository = { applyCloudSchedule } as unknown as ScheduleLocalRepository;
    const writer = new LocalScheduleWriter(repository);

    await expect(
      writer.applyCommandResult('account-a', {
        operation: 'create_schedule',
        status: 'applied',
        schedule: {
          id: 'schedule-a',
          schedule_type: 'time',
          schedule_kind: 'once',
          category: 'unsupported',
          title: 'Invalid',
          timezone: 'Asia/Shanghai',
        },
      }),
    ).rejects.toThrow('category has an unsupported value');
    expect(applyCloudSchedule).not.toHaveBeenCalled();
  });
});
