import type {
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
} from '../../features/reminder/application/interfaces';

/** 固定闹钟适配器，始终标记为已调度（进程内占位 id）。 */
export class MockAlarmScheduler implements AlarmSchedulerPort {
  async schedule(request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt> {
    return {
      alarm_id: `mock-alarm-${request.schedule_id}`,
      schedule_id: request.schedule_id,
      scheduled: true,
    };
  }

  async cancel(_alarmId: string | null): Promise<{ cancelled: boolean }> {
    return { cancelled: true };
  }

  async rebuild(
    requests: readonly AlarmScheduleRequest[],
  ): Promise<readonly AlarmScheduleReceipt[]> {
    return Promise.all(requests.map((request) => this.schedule(request)));
  }
}
