import type { ReminderStateStore } from '../../application/interfaces';
import type { ReminderDisposition, ReminderRuntimeState } from '../../domain';

const MOCK_STATE: ReminderRuntimeState = {
  reminder_disposition_state: null,
  next_trigger_at: '2026-08-07T01:00:00.000Z',
  snoozed_until: null,
  geofence_armed: false,
  disposition_updated_at: null,
  sync_status: 'synced',
  recorded_location: null,
};

/** 读取结果固定的本地状态空操作适配器，不打开本地数据库。 */
export class MockReminderStateStore implements ReminderStateStore {
  async read(_scheduleId: string): Promise<ReminderRuntimeState | null> {
    return { ...MOCK_STATE };
  }

  async write(_scheduleId: string, _state: ReminderRuntimeState): Promise<void> {
    return Promise.resolve();
  }

  async setDisposition(_scheduleId: string, _disposition: ReminderDisposition): Promise<void> {
    return Promise.resolve();
  }
}
