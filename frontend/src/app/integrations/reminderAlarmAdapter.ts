import type { AlarmPort } from '@/features/schedule';
import {
  cancelAndroidAlarm,
  isAndroidAlarmSupported,
  syncScheduleAlarm,
} from '@/features/reminder';
import type { AppDialogOptions } from '@/shared/components/AppDialogProvider';

export function createReminderAlarmAdapter(
  showNotice: (options: AppDialogOptions) => void | Promise<void>,
): AlarmPort {
  return {
    async syncForSchedule(input) {
      try {
        return await syncScheduleAlarm(input);
      } catch {
        // The schedule remains persisted even when its local alarm fails.
        void showNotice({
          title: '闹钟同步失败',
          message: '日程已保存，但系统闹钟未创建成功。',
        });
        return null;
      }
    },
    async cancel(alarmId) {
      await cancelAndroidAlarm(alarmId);
      // Unsupported platforms do not own the reference, so retain it in the
      // schedule entity. Android owns and cancels the local alarm record.
      return isAndroidAlarmSupported() ? null : (alarmId ?? null);
    },
  };
}
