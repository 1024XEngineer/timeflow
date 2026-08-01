import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  Schedule,
  ScheduleUpsertCommand,
  ScheduleUpsertPayload as ScheduleDraft,
  ScheduleUpsertResponse,
} from '@/contracts';
import { ScheduleService } from '@/features/schedule/application/ScheduleService';
import { ScheduleCache } from '@/features/schedule/data/ScheduleCache';
import type { ScheduleRepositoryPort } from '@/features/schedule/data/ScheduleRepositoryPort';
import { makeSchedule } from '@test/fixtures';

function makeDraft(overrides: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return {
    source_mode: 'manual',
    schedule_type: 'time',
    title: '新会议',
    start_time: new Date(Date.now() + 3_600_000).toISOString(),
    end_time: null,
    time_remind_offset_minutes: 5,
    ...overrides,
  };
}

function upsertOk(command: ScheduleUpsertCommand, id: string): ScheduleUpsertResponse {
  return {
    type: 'schedule.upsert.result',
    request_id: command.request_id,
    ok: true,
    payload: {
      schedule_id: id,
      schedule_type: command.payload.schedule_type,
      status: 'scheduled',
      conflicts: [],
      geofence_armed: true,
    },
  };
}

describe('ScheduleService', () => {
  let cache: ScheduleCache;
  let repository: jest.Mocked<ScheduleRepositoryPort>;
  let syncForSchedule: jest.MockedFunction<
    NonNullable<ConstructorParameters<typeof ScheduleService>[0]['alarmAdapter']>['syncForSchedule']
  >;
  let cancel: jest.MockedFunction<
    NonNullable<ConstructorParameters<typeof ScheduleService>[0]['alarmAdapter']>['cancel']
  >;
  let notifyConflicts: jest.MockedFunction<
    NonNullable<ConstructorParameters<typeof ScheduleService>[0]['notifyConflicts']>
  >;
  let service: ScheduleService;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new ScheduleCache();
    repository = {
      list: jest.fn(async () => [] as Schedule[]),
      upsert: jest.fn(async (command: ScheduleUpsertCommand) =>
        upsertOk(command, command.payload.schedule_id ?? 'schedule_auto'),
      ),
      updateStatus: jest.fn(async (id: string, status: 'scheduled' | 'done') => ({
        type: 'schedule.status.result' as const,
        request_id: `req_status_${id}`,
        ok: true as const,
        payload: { schedule_id: id, status },
      })),
      notifyDeleted: jest.fn(async (id: string) => ({
        type: 'schedule.deleted.ack' as const,
        request_id: `req_deleted_${id}`,
        schedule_id: id,
        ok: true as const,
      })),
      subscribe: jest.fn(() => () => undefined),
    };
    syncForSchedule = jest.fn(async () => null);
    cancel = jest.fn(async () => null);
    notifyConflicts = jest.fn();
    service = new ScheduleService({
      repository,
      cache,
      getUserId: () => 'default_user',
      alarmAdapter: { syncForSchedule, cancel },
      notifyConflicts,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('bootstraps from repository.list into cache', async () => {
    const seed = [makeSchedule({ id: 'seed' })];
    repository.list.mockResolvedValueOnce(seed);
    await service.bootstrap();
    expect(service.getItems()).toEqual(seed);
  });

  it('creates a schedule via upsert and caches it', async () => {
    const saved = await service.saveDraft(makeDraft({ title: 'A' }));
    expect(saved.title).toBe('A');
    expect(saved.id).toBe('schedule_auto');
    expect(service.getItems()).toHaveLength(1);
    expect(repository.upsert).toHaveBeenCalled();
    expect(repository.upsert.mock.calls[0]![0].payload.schedule_id).toBeUndefined();
  });

  it('alerts when upsert reports conflicts', async () => {
    repository.upsert.mockImplementation(async (command) => ({
      type: 'schedule.upsert.result',
      request_id: command.request_id,
      ok: true,
      payload: {
        schedule_id: command.payload.schedule_id ?? 'x',
        schedule_type: command.payload.schedule_type,
        status: 'scheduled',
        conflicts: [
          {
            schedule_id: 'other',
            title: '已有会议',
            start_time: new Date().toISOString(),
            end_time: null,
          },
        ],
        geofence_armed: true,
      },
    }));

    await service.saveDraft(makeDraft());
    expect(notifyConflicts).toHaveBeenCalledWith([expect.objectContaining({ title: '已有会议' })]);
  });

  it('updates an existing schedule when schedule_id is set', async () => {
    await service.saveDraft(makeDraft({ schedule_id: 'schedule_edit', title: '旧标题' }));
    await service.saveDraft(makeDraft({ schedule_id: 'schedule_edit', title: '新标题' }));
    expect(service.getItems()).toHaveLength(1);
    expect(service.getItems()[0]?.title).toBe('新标题');
  });

  it('syncs android alarms when adapter returns an id', async () => {
    syncForSchedule.mockResolvedValue('alarm_99');
    const saved = await service.saveDraft(makeDraft({ title: '安卓会议' }));
    expect(syncForSchedule).toHaveBeenCalled();
    expect(saved.system_schedule_ref_id).toBe('alarm_99');
  });

  it('keeps a confirmed save in cache when alarm sync fails', async () => {
    syncForSchedule.mockRejectedValueOnce(new Error('permission denied'));

    await expect(service.saveDraft(makeDraft({ title: '已保存会议' }))).rejects.toThrow(
      '日程已保存到服务端，但系统提醒同步失败：permission denied',
    );

    expect(service.getItems()).toEqual([
      expect.objectContaining({ id: 'schedule_auto', title: '已保存会议', status: 'scheduled' }),
    ]);
  });

  it('toggles done through updateStatus and re-arms on undo', async () => {
    syncForSchedule.mockResolvedValue('alarm_old');
    await service.saveDraft(
      makeDraft({
        schedule_id: 'toggle_1',
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const item = service.getItems()[0]!;
    await service.toggleDone(item);
    expect(repository.updateStatus).toHaveBeenCalledWith('toggle_1', 'done');
    expect(repository.notifyDeleted).not.toHaveBeenCalled();
    expect(service.getItems()[0]?.status).toBe('done');

    syncForSchedule.mockResolvedValue('alarm_rearm');
    await service.toggleDone(service.getItems()[0]!);
    expect(repository.updateStatus).toHaveBeenCalledWith('toggle_1', 'scheduled');
    expect(service.getItems()[0]?.status).toBe('scheduled');
    expect(syncForSchedule).toHaveBeenCalled();
  });

  it('marks a schedule deleted and cancels its alarm', async () => {
    syncForSchedule.mockResolvedValue('alarm_del');
    await service.saveDraft(makeDraft({ schedule_id: 'del_1' }));
    await service.deleteSchedule(service.getItems()[0]!);
    expect(repository.notifyDeleted).toHaveBeenCalledWith('del_1');
    expect(cancel).toHaveBeenCalledWith('alarm_del');
    expect(service.getItems()[0]?.status).toBe('deleted');
    expect(service.getItems()[0]?.system_schedule_ref_id).toBeNull();
  });

  it('keeps a confirmed status update when alarm cancellation fails', async () => {
    const schedule = makeSchedule({ id: 'toggle-failed', system_schedule_ref_id: 'alarm-1' });
    cache.replaceAll([schedule]);
    cancel.mockRejectedValueOnce(new Error('native alarm unavailable'));

    await expect(service.toggleDone(schedule)).rejects.toThrow(
      '日程状态已在服务端更新，但系统提醒同步失败',
    );

    expect(service.getItems()[0]).toEqual(
      expect.objectContaining({ status: 'done', system_schedule_ref_id: 'alarm-1' }),
    );
  });

  it('keeps a confirmed deletion when alarm cancellation fails', async () => {
    const schedule = makeSchedule({ id: 'delete-failed', system_schedule_ref_id: 'alarm-2' });
    cache.replaceAll([schedule]);
    cancel.mockRejectedValueOnce(new Error('native alarm unavailable'));

    await expect(service.deleteSchedule(schedule)).rejects.toThrow(
      '日程已在服务端删除，但系统提醒取消失败',
    );

    expect(service.getItems()[0]).toEqual(
      expect.objectContaining({ status: 'deleted', system_schedule_ref_id: 'alarm-2' }),
    );
  });

  it('keeps the alarm reference returned by the platform adapter', async () => {
    cancel.mockResolvedValue('remote_alarm');
    cache.replaceAll([makeSchedule({ id: 'remote', system_schedule_ref_id: 'local_alarm' })]);

    await service.deleteSchedule(service.getItems()[0]!);

    expect(service.getItems()[0]?.system_schedule_ref_id).toBe('remote_alarm');
  });

  it('does not mutate cache or alarms when delete is rejected', async () => {
    repository.notifyDeleted.mockResolvedValueOnce({
      type: 'schedule.deleted.ack',
      request_id: 'req_delete_failed',
      schedule_id: 'reject',
      ok: false,
      error: { code: 'denied', message: '删除被拒绝', details: null },
    });
    const schedule = makeSchedule({ id: 'reject', system_schedule_ref_id: 'alarm_reject' });
    cache.replaceAll([schedule]);

    await expect(service.deleteSchedule(schedule)).rejects.toThrow('删除被拒绝');
    expect(cancel).not.toHaveBeenCalled();
    expect(service.getItems()[0]).toEqual(schedule);
  });

  it('ignores toggle and delete for already deleted items', async () => {
    cache.replaceAll([makeSchedule({ id: 'gone', status: 'deleted' })]);
    await service.toggleDone(service.getItems()[0]!);
    await service.deleteSchedule(service.getItems()[0]!);
    expect(repository.updateStatus).not.toHaveBeenCalled();
    expect(repository.notifyDeleted).not.toHaveBeenCalled();
  });
});
