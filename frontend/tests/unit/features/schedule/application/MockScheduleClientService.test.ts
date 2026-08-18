import { describe, expect, it } from '@jest/globals';

import { MockScheduleClientService } from '../../../../../src/features/schedule/application/MockScheduleClientService';

describe('MockScheduleClientService', () => {
  const now = () => new Date('2026-08-18T01:00:00.000Z');
  const timezone = 'Asia/Shanghai';

  it('returns today and tomorrow time occurrences in an inclusive local range', async () => {
    const service = new MockScheduleClientService(now);
    const occurrences = await service.getSchedulesByRange({
      accountId: 'mock-account-001',
      startDate: '2026-08-18',
      endDate: '2026-08-20',
      timezone,
    });

    expect(occurrences.map((item) => item.title)).toEqual(['团队共创日', '项目例会', '设计评审']);
  });

  it('keeps the all-day item on the selected local day', async () => {
    const service = new MockScheduleClientService(now);
    const today = await service.getSchedulesByDay({
      accountId: 'mock-account-001',
      selectedDate: '2026-08-18',
      timezone,
    });
    const tomorrow = await service.getSchedulesByDay({
      accountId: 'mock-account-001',
      selectedDate: '2026-08-19',
      timezone,
    });

    expect(today.map((item) => item.title)).toEqual(['团队共创日', '项目例会']);
    expect(tomorrow.map((item) => item.title)).toEqual(['设计评审']);
  });

  it('returns the location fixture for any non-empty account', async () => {
    const service = new MockScheduleClientService(now);
    await expect(service.getLocationSchedules({ accountId: 'mock-account-001' })).resolves.toEqual([
      expect.objectContaining({
        locationName: '停车场 B2',
        title: '取车提醒',
      }),
    ]);
  });

  it('rejects empty account queries', async () => {
    const service = new MockScheduleClientService(now);
    await expect(
      service.getSchedulesByDay({ accountId: ' ', selectedDate: '2026-08-18', timezone }),
    ).rejects.toThrow(TypeError);
    await expect(service.getLocationSchedules({ accountId: '' })).rejects.toThrow(TypeError);
  });
});
