import type {
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
} from '../../features/reminder/application/interfaces';

/** 固定闹钟适配器，后续可替换为原生精确闹钟接口。 */
export class MockAlarmScheduler implements AlarmSchedulerPort {
  async schedule(request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt> {
    return {
      alarm_id: 'mock-alarm-001',
      schedule_id: request.schedule_id,
    };
  }

  async cancel(_alarmId: string | null): Promise<{ cancelled: boolean }> {
    return { cancelled: true };
  }

  async rebuild(
    requests: readonly AlarmScheduleRequest[],
  ): Promise<readonly AlarmScheduleReceipt[]> {
    return requests.length > 0
      ? [{ alarm_id: 'mock-alarm-001', schedule_id: requests[0]!.schedule_id }]
      : [];
  }
}
