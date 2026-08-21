import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  LocalReminderDelivery,
  LocalReminderDispositionSync,
  LocalReminderRecovery,
  NoopPopup,
} from '../../../../../src/features/reminder/data/local/LocalReminderAdapters';
import { SqliteLocalScheduleReader } from '../../../../../src/features/reminder/data/local/SqliteLocalScheduleReader';
import { SqliteReminderStateStore } from '../../../../../src/features/reminder/data/local/SqliteReminderStateStore';
import type {
  LocalReminderRuntimeUpdate,
  LocalScheduleRow,
  ScheduleLocalRepository,
} from '../../../../../src/features/schedule/data';

const START_TIME = '2026-08-10T07:00:00.000Z';

afterEach(() => {
  jest.useRealTimers();
});

describe('local reminder adapters', () => {
  it('returns local delivery, popup, recovery, and disposition receipts', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T08:00:00Z'));
    const delivery = new LocalReminderDelivery();
    const popup = new NoopPopup();
    const recovery = new LocalReminderRecovery();
    const sync = new LocalReminderDispositionSync();

    await expect(
      delivery.deliver({
        reminder_id: 'reminder-a',
        schedule_id: 'schedule-a',
        title: 'Team sync',
        strength: 'medium',
        trigger: {
          reminder_id: 'reminder-a',
          schedule_id: 'schedule-a',
          reason: 'at_time',
          triggered_at: '2026-08-19T08:00:00Z',
        },
      }),
    ).resolves.toEqual({
      delivery_id: `delivery-schedule-a-${Date.now()}`,
      schedule_id: 'schedule-a',
      delivered_at: '2026-08-19T08:00:00.000Z',
      channels: [],
      used_fallback_audio: false,
    });
    await expect(delivery.dismiss('schedule-a')).resolves.toBeUndefined();
    await expect(
      popup.show({ popup_id: 'popup-a', title: 'Team sync', body: 'Starts now' }),
    ).resolves.toEqual({ popup_id: 'popup-a', visible: false });
    await expect(popup.dismiss('popup-a')).resolves.toBeUndefined();

    const recoveryReceipt = { registered: true, recovery_id: `recovery-${Date.now()}` };
    await expect(recovery.registerForRestart()).resolves.toEqual(recoveryReceipt);
    await expect(recovery.restoreAfterRestart()).resolves.toEqual(recoveryReceipt);
    await expect(
      sync.submitConfirmed({
        schedule_id: 'schedule-a',
        state: 'confirmed',
        updated_at: '2026-08-19T08:00:00Z',
        snoozed_until: null,
        sync_status: 'pending',
      }),
    ).resolves.toEqual({ schedule_id: 'schedule-a', accepted: true });
  });
});

describe('SqliteLocalScheduleReader', () => {
  it('reads, maps, refreshes, unsubscribes, and detaches its repository target', async () => {
    const reminderRow = scheduleRow();
    const noReminderRow = scheduleRow({
      id: 'schedule-b',
      reminder_type: null,
      reminder_offset_minutes: null,
      reminder_strength: null,
      geofence_armed: 1,
    });
    const repository = repositoryStub({ rows: [reminderRow, noReminderRow] });
    const reader = new SqliteLocalScheduleReader();

    expect(await reader.listReminderSchedules()).toEqual([]);
    expect(await reader.getReminderSchedule('schedule-a')).toBeNull();

    reader.attach(repository.value, 'account-a');
    const schedules = await reader.listReminderSchedules();
    expect(repository.listSchedules).toHaveBeenCalledWith('account-a');
    expect(schedules).toEqual([
      expect.objectContaining({
        id: 'schedule-a',
        reminder: expect.objectContaining({ reminder_strength: 'medium' }),
        runtime: expect.objectContaining({ geofence_armed: false }),
      }),
      expect.objectContaining({
        id: 'schedule-b',
        reminder: null,
        runtime: expect.objectContaining({ geofence_armed: true }),
      }),
    ]);

    repository.getSchedule.mockResolvedValueOnce(reminderRow).mockResolvedValueOnce(null);
    expect(await reader.getReminderSchedule('schedule-a')).toMatchObject({ id: 'schedule-a' });
    expect(await reader.getReminderSchedule('missing')).toBeNull();

    const listener = jest.fn();
    const unsubscribe = reader.subscribe(listener);
    await reader.refresh();
    expect(listener).toHaveBeenCalledWith(schedules);
    unsubscribe();
    await reader.refresh();
    expect(listener).toHaveBeenCalledTimes(1);

    reader.detach();
    expect(await reader.listReminderSchedules()).toEqual([]);
  });
});

describe('SqliteReminderStateStore', () => {
  it('persists runtime and disposition state while attached', async () => {
    const row = scheduleRow({ geofence_armed: 1, next_trigger_at: START_TIME });
    const repository = repositoryStub({ row });
    const store = new SqliteReminderStateStore();
    store.attach(repository.value, 'account-a');

    expect(await store.read('schedule-a')).toEqual({
      reminder_disposition_state: null,
      next_trigger_at: START_TIME,
      snoozed_until: null,
      geofence_armed: true,
      disposition_updated_at: null,
      sync_status: 'synced',
      recorded_location: null,
    });

    await store.write('schedule-a', {
      reminder_disposition_state: 'pending',
      next_trigger_at: START_TIME,
      snoozed_until: null,
      geofence_armed: false,
      disposition_updated_at: START_TIME,
      sync_status: 'pending',
      recorded_location: null,
    });
    expect(repository.updateReminderRuntime).toHaveBeenCalledWith('account-a', 'schedule-a', {
      reminder_disposition_state: 'pending',
      next_trigger_at: START_TIME,
      snoozed_until: null,
      geofence_armed: 0,
      disposition_updated_at: START_TIME,
      sync_status: 'pending',
    });

    await store.setDisposition('schedule-a', {
      schedule_id: 'schedule-a',
      state: 'confirmed',
      updated_at: '2026-08-10T07:05:00.000Z',
      snoozed_until: null,
      sync_status: 'pending',
    });
    expect(repository.updateReminderRuntime).toHaveBeenLastCalledWith(
      'account-a',
      'schedule-a',
      expect.objectContaining({
        reminder_disposition_state: 'confirmed',
        next_trigger_at: START_TIME,
        geofence_armed: 1,
      }),
    );
  });

  it('handles detached and missing schedules without writing', async () => {
    const repository = repositoryStub();
    const store = new SqliteReminderStateStore();
    const runtime = runtimeState();
    const disposition = {
      schedule_id: 'missing',
      state: 'confirmed' as const,
      updated_at: START_TIME,
      snoozed_until: null,
      sync_status: 'pending' as const,
    };

    expect(await store.read('missing')).toBeNull();
    await store.write('missing', runtime);
    await store.setDisposition('missing', disposition);

    store.attach(repository.value, 'account-a');
    expect(await store.read('missing')).toBeNull();
    await store.setDisposition('missing', disposition);
    store.detach();

    expect(repository.updateReminderRuntime).toHaveBeenCalledTimes(1);
    expect(repository.updateReminderRuntime).toHaveBeenCalledWith(
      'account-a',
      'missing',
      expect.objectContaining({ next_trigger_at: null, geofence_armed: 0 }),
    );
  });

  it('advances recurring schedules and tolerates exhausted or invalid rules', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T07:00:00.000Z'));
    const repository = repositoryStub();
    const store = new SqliteReminderStateStore();
    store.attach(repository.value, 'account-a');

    repository.getSchedule.mockResolvedValueOnce(
      scheduleRow({
        schedule_kind: 'recurring',
        recurrence_rule: 'FREQ=WEEKLY;COUNT=4',
        start_time: START_TIME,
        next_trigger_at: null,
        reminder_disposition_state: 'confirmed',
      }),
    );
    expect(await store.read('schedule-a')).toMatchObject({
      reminder_disposition_state: null,
      next_trigger_at: '2026-08-24T07:00:00.000Z',
    });

    for (const row of [
      scheduleRow({ schedule_kind: 'recurring', start_time: null, next_trigger_at: null }),
      scheduleRow({
        schedule_kind: 'recurring',
        recurrence_rule: null,
        next_trigger_at: null,
      }),
      scheduleRow({
        schedule_kind: 'recurring',
        timezone: 'Invalid/Timezone',
        next_trigger_at: null,
      }),
      scheduleRow({
        schedule_kind: 'recurring',
        recurrence_rule: 'FREQ=WEEKLY;COUNT=1',
        next_trigger_at: null,
      }),
      scheduleRow({
        schedule_kind: 'recurring',
        recurrence_rule: 'INVALID',
        next_trigger_at: null,
      }),
    ]) {
      repository.getSchedule.mockResolvedValueOnce(row);
      expect((await store.read(row.id))?.next_trigger_at).toBeNull();
    }
  });
});

function repositoryStub({
  row = null,
  rows = [],
}: { row?: LocalScheduleRow | null; rows?: LocalScheduleRow[] } = {}) {
  const getSchedule = jest
    .fn<(accountId: string, scheduleId: string) => Promise<LocalScheduleRow | null>>()
    .mockResolvedValue(row);
  const listSchedules = jest
    .fn<(accountId: string) => Promise<LocalScheduleRow[]>>()
    .mockResolvedValue(rows);
  const updateReminderRuntime = jest
    .fn<
      (
        accountId: string,
        scheduleId: string,
        runtime: LocalReminderRuntimeUpdate,
      ) => Promise<boolean>
    >()
    .mockResolvedValue(true);

  return {
    getSchedule,
    listSchedules,
    updateReminderRuntime,
    value: {
      getSchedule,
      listSchedules,
      updateReminderRuntime,
    } as unknown as ScheduleLocalRepository,
  };
}

function runtimeState() {
  return {
    reminder_disposition_state: null,
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: false,
    disposition_updated_at: null,
    sync_status: 'pending' as const,
    recorded_location: null,
  };
}

function scheduleRow(overrides: Partial<LocalScheduleRow> = {}): LocalScheduleRow {
  return {
    id: 'schedule-a',
    account_id: 'account-a',
    schedule_type: 'time',
    schedule_kind: 'once',
    category: null,
    title: 'Team sync',
    is_all_day: 0,
    start_time: START_TIME,
    end_time: null,
    timezone: 'UTC',
    recurrence_rule: 'FREQ=WEEKLY;COUNT=4',
    location_name: null,
    latitude: null,
    longitude: null,
    reminder_type: 'before_start',
    reminder_trigger_at: null,
    reminder_offset_minutes: 15,
    reminder_strength: 'medium',
    reminder_disposition_state: null,
    next_trigger_at: null,
    snoozed_until: null,
    geofence_armed: 0,
    disposition_updated_at: null,
    sync_status: 'synced',
    status: 'active',
    cloud_revision: 1,
    updated_at: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}
