import type { Schedule } from '@/contracts';

export type AlarmPort = {
  /**
   * Returns the system reference that should be persisted after syncing.
   * Adapters for platforms without a local alarm should return the previous
   * reference, while adapters that own the alarm lifecycle may return null
   * when no alarm is armed.
   */
  syncForSchedule(input: {
    scheduleType: Schedule['schedule_type'];
    title: string;
    startTime: string | null;
    offsetMinutes: number;
    previousAlarmId: string | null;
    shouldArm: boolean;
  }): Promise<string | null>;
  /**
   * Cancels an alarm and returns the reference that should remain on the
   * schedule entity. This keeps platform-specific reference semantics out of
   * the application service.
   */
  cancel(alarmId: string | null | undefined): Promise<string | null>;
};
