import type {
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
} from '../../features/reminder/application/interfaces';
import {
  isTimeflowAlarmAvailable,
  nativeAreAlarmPermissionsGranted,
  nativeCancelAlarm,
  nativeScheduleAlarm,
} from './native/TimeflowAlarmBridge';

/** Android TimeflowAlarm 适配器；无法挂上时返回 scheduled=false。 */
export class NativeAlarmScheduler implements AlarmSchedulerPort {
  async schedule(request: AlarmScheduleRequest): Promise<AlarmScheduleReceipt> {
    if (!isTimeflowAlarmAvailable()) {
      return unscheduled(request.schedule_id);
    }

    const triggerAtMillis = Date.parse(request.trigger_at);
    if (!Number.isFinite(triggerAtMillis) || triggerAtMillis <= Date.now()) {
      return unscheduled(request.schedule_id);
    }

    const ready = await nativeAreAlarmPermissionsGranted();
    if (!ready) {
      return unscheduled(request.schedule_id);
    }

    const alarmId = await nativeScheduleAlarm(triggerAtMillis, request.title);
    if (alarmId == null || alarmId.length === 0) {
      return unscheduled(request.schedule_id);
    }

    return {
      alarm_id: alarmId,
      schedule_id: request.schedule_id,
      scheduled: true,
    };
  }

  async cancel(alarmId: string | null): Promise<{ cancelled: boolean }> {
    if (alarmId == null || alarmId.length === 0) {
      return { cancelled: false };
    }
    await nativeCancelAlarm(alarmId);
    return { cancelled: true };
  }

  async rebuild(
    requests: readonly AlarmScheduleRequest[],
  ): Promise<readonly AlarmScheduleReceipt[]> {
    const receipts: AlarmScheduleReceipt[] = [];
    for (const request of requests) {
      receipts.push(await this.schedule(request));
    }
    return receipts;
  }
}

function unscheduled(scheduleId: string): AlarmScheduleReceipt {
  return {
    alarm_id: '',
    schedule_id: scheduleId,
    scheduled: false,
  };
}
