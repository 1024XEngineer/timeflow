import {
  areAndroidAlarmPermissionsGranted,
  cancelAndroidAlarm,
  computeScheduleAlarmTriggerMillis,
  isAndroidAlarmSupported,
  scheduleAndroidAlarm,
} from '../native/alarmScheduler';

export async function syncScheduleAlarm(input: {
  scheduleType: 'time' | 'location';
  title: string;
  startTime: string | null;
  offsetMinutes: number;
  previousAlarmId: string | null;
  shouldArm: boolean;
}): Promise<string | null> {
  if (!isAndroidAlarmSupported()) {
    return input.previousAlarmId;
  }

  if (input.previousAlarmId) {
    await cancelAndroidAlarm(input.previousAlarmId);
  }

  if (!input.shouldArm || input.scheduleType !== 'time') {
    return null;
  }

  const triggerAtMillis = computeScheduleAlarmTriggerMillis(input.startTime, input.offsetMinutes);
  if (triggerAtMillis == null) {
    return null;
  }

  // 权限在进入 App 时申请；创建时只静默检查，不再跳转设置页。
  const ready = await areAndroidAlarmPermissionsGranted();
  if (!ready) {
    return null;
  }

  return scheduleAndroidAlarm(triggerAtMillis, input.title);
}
