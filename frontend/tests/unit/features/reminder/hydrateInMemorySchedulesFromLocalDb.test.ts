import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { hydrateInMemorySchedulesFromLocalDb } from '../../../../src/features/reminder/data/local/hydrateInMemorySchedulesFromLocalDb';
import { InMemoryLocalScheduleReader } from '../../../../src/features/reminder/data/local/InMemoryLocalScheduleReader';
import { openTimeflowDatabase } from '../../../../src/infrastructure/database';
import { ScheduleLocalRepository } from '../../../../src/features/schedule/data';
import type { LocalScheduleRow } from '../../../../src/features/schedule/data';

jest.mock('../../../../src/infrastructure/database', () => ({
  openTimeflowDatabase: jest.fn(),
}));

jest.mock('../../../../src/features/schedule/data', () => ({
  ScheduleLocalRepository: jest.fn(),
}));

const mockedOpen = openTimeflowDatabase as jest.MockedFunction<typeof openTimeflowDatabase>;
const MockedRepository = ScheduleLocalRepository as jest.MockedClass<
  typeof ScheduleLocalRepository
>;

function row(overrides: Partial<LocalScheduleRow> = {}): LocalScheduleRow {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'once',
    title: '晨会',
    is_all_day: 0,
    start_time: '2026-08-13T09:00:00.000Z',
    end_time: null,
    timezone: 'Asia/Shanghai',
    recurrence_rule: null,
    location_name: null,
    latitude: null,
    longitude: null,
    reminder_type: 'at_time',
    reminder_trigger_at: '2026-08-13T09:00:00.000Z',
    reminder_offset_minutes: null,
    reminder_strength: 'medium',
    reminder_disposition_state: null,
    status: 'active',
    cloud_revision: 1,
    updated_at: '2026-08-13T08:00:00.000Z',
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: 0,
    disposition_updated_at: null,
    sync_status: 'pending',
    ...overrides,
  };
}

describe('hydrateInMemorySchedulesFromLocalDb', () => {
  const listSchedules = jest.fn<ScheduleLocalRepository['listSchedules']>();

  beforeEach(() => {
    mockedOpen.mockReset();
    mockedOpen.mockResolvedValue({} as never);
    listSchedules.mockReset();
    MockedRepository.mockReset();
    MockedRepository.mockImplementation((() => ({ listSchedules })) as never);
  });

  it('loads active rows into the in-memory reader', async () => {
    listSchedules.mockResolvedValue([
      row({ id: 'active' }),
      row({ id: 'gone', status: 'deleted' }),
    ]);
    const reader = new InMemoryLocalScheduleReader();
    await expect(hydrateInMemorySchedulesFromLocalDb(reader, 'account-a')).resolves.toBe(1);
    expect(listSchedules).toHaveBeenCalledWith('account-a');
    expect(reader.list().map((schedule) => schedule.id)).toEqual(['active']);
  });

  it('clears the reader when the local database cannot be opened', async () => {
    mockedOpen.mockRejectedValue(new Error('no sqlite'));
    const reader = new InMemoryLocalScheduleReader();
    reader.upsert({
      id: 'stale',
      account_id: 'account-a',
      title: '旧',
      schedule_type: 'time',
      schedule_kind: 'once',
      is_all_day: false,
      start_time: null,
      end_time: null,
      timezone: 'Asia/Shanghai',
      recurrence_rule: null,
      location_name: null,
      latitude: null,
      longitude: null,
      geofence_radius_meters: 100,
      reminder: null,
      runtime: {
        reminder_disposition_state: null,
        next_trigger_at: null,
        snoozed_until: null,
        geofence_armed: false,
        disposition_updated_at: null,
        sync_status: 'pending',
        recorded_location: null,
      },
      status: 'active',
      revision: 1,
      cloud_revision: 1,
      updated_at: '2026-08-13T08:00:00.000Z',
    });
    await expect(hydrateInMemorySchedulesFromLocalDb(reader, 'account-a')).resolves.toBe(0);
    expect(reader.list()).toEqual([]);
  });
});
