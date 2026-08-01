import type { ScheduleConflictNotifier } from '@/features/schedule';
import type { AppDialogOptions } from '@/shared/components/AppDialogProvider';

/** App-owned UI adapter for conflict feedback emitted by the schedule use case. */
export function createScheduleConflictNotifier(
  showNotice: (options: AppDialogOptions) => void | Promise<void>,
): ScheduleConflictNotifier {
  return (conflicts) => {
    if (conflicts.length === 0) return;
    void showNotice({
      title: '当前时段已有日程',
      message: conflicts.map((conflict) => conflict.title).join('、'),
    });
  };
}
