import type { ReminderStateStore } from '../../application/interfaces';
import type { ReminderDisposition, ReminderRuntimeState } from '../../domain';

/** 进程内提醒运行时状态存储，供真实协调器在接入本地 DB 前使用。 */
export class MemoryReminderStateStore implements ReminderStateStore {
  private readonly states = new Map<string, ReminderRuntimeState>();
  private readonly dispositions = new Map<string, ReminderDisposition>();

  async read(scheduleId: string): Promise<ReminderRuntimeState | null> {
    const state = this.states.get(scheduleId);
    return state == null ? null : { ...state };
  }

  async write(scheduleId: string, state: ReminderRuntimeState): Promise<void> {
    this.states.set(scheduleId, { ...state });
  }

  async setDisposition(scheduleId: string, disposition: ReminderDisposition): Promise<void> {
    this.dispositions.set(scheduleId, { ...disposition });
    const current = this.states.get(scheduleId);
    this.states.set(scheduleId, {
      ...(current ?? {
        reminder_disposition_state: null,
        next_trigger_at: null,
        snoozed_until: null,
        geofence_armed: false,
        disposition_updated_at: null,
        sync_status: 'pending',
        recorded_location: null,
      }),
      reminder_disposition_state: disposition.state,
      snoozed_until: disposition.snoozed_until,
      disposition_updated_at: disposition.updated_at,
      sync_status: disposition.sync_status,
    });
  }
}
