import type {
  AlarmNativeDisposition,
  AlarmNativeEvent,
  AlarmScheduleReceipt,
  AlarmScheduleRequest,
  AlarmSchedulerPort,
} from '../../features/reminder/application/interfaces';
import {
  isTimeflowAlarmAvailable,
  nativeAreAlarmPermissionsGranted,
  nativeCancelAlarm,
  nativeCancelAllAlarms,
  nativeConsumeAlarmDispositions,
  nativeScheduleAlarm,
  nativeStopAlarmRinging,
  subscribeNativeAlarmEvents,
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

    const alarmId = await nativeScheduleAlarm(triggerAtMillis, request.title, request.schedule_id);
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
    // 冷启动 registrations 为空时也要清掉 SharedPreferences 里的孤儿闹钟。
    await nativeCancelAllAlarms();
    const receipts: AlarmScheduleReceipt[] = [];
    for (const request of requests) {
      receipts.push(await this.schedule(request));
    }
    return receipts;
  }

  async stopRinging(): Promise<void> {
    await nativeStopAlarmRinging();
  }

  subscribe(listener: (event: AlarmNativeEvent) => void): () => void {
    return subscribeNativeAlarmEvents((payload) => {
      listener({
        type: payload.type,
        schedule_id: payload.scheduleId,
        alarm_id: payload.alarmId,
        title: payload.title,
        at: new Date(payload.atMillis || Date.now()).toISOString(),
      });
    });
  }

  async consumeNativeDispositions(): Promise<readonly AlarmNativeDisposition[]> {
    const rows = await nativeConsumeAlarmDispositions();
    return rows
      .map((row) => {
        const state =
          row.state === 'confirmed'
            ? 'confirmed'
            : row.state === 'pending'
              ? 'pending'
              : row.state === 'snoozed'
                ? 'snoozed'
                : null;
        if (state == null || !row.scheduleId) return null;
        return {
          schedule_id: row.scheduleId,
          alarm_id: row.alarmId ?? '',
          state,
          updated_at: new Date(row.updatedAtMillis || Date.now()).toISOString(),
        } satisfies AlarmNativeDisposition;
      })
      .filter((row): row is AlarmNativeDisposition => row != null);
  }
}

function unscheduled(scheduleId: string): AlarmScheduleReceipt {
  return {
    alarm_id: '',
    schedule_id: scheduleId,
    scheduled: false,
  };
}
