import type { LocalReminderRuntimeUpdate, ScheduleLocalRepository } from '../../../schedule/data';
import type { ReminderStateStore } from '../../application/interfaces';
import type { ReminderDisposition, ReminderRuntimeState } from '../../domain';

type Target = { repository: ScheduleLocalRepository; accountId: string };

/**
 * 提醒运行时状态（响没响、确认没确认）的真实持久化：写 SQLite `local_schedules` 的
 * 运行时字段。跟 SqliteLocalScheduleReader 一样用 attach()/detach() 延迟绑定——
 * createAppServices() 构造时账号和仓储都还没有，整个 App 生命周期只有这一个实例。
 *
 * 没有这个类之前用的是 MemoryReminderStateStore（纯内存），App 进程一死状态就丢，
 * 已经响过的到点提醒下次启动会被当成全新的重新弹一遍。
 */
export class SqliteReminderStateStore implements ReminderStateStore {
  private target: Target | null = null;

  public attach(repository: ScheduleLocalRepository, accountId: string): void {
    this.target = { repository, accountId };
  }

  public detach(): void {
    this.target = null;
  }

  public async read(scheduleId: string): Promise<ReminderRuntimeState | null> {
    if (this.target === null) return null;
    const row = await this.target.repository.getSchedule(this.target.accountId, scheduleId);
    if (row === null) return null;
    return {
      reminder_disposition_state: row.reminder_disposition_state,
      next_trigger_at: row.next_trigger_at,
      snoozed_until: row.snoozed_until,
      geofence_armed: row.geofence_armed === 1,
      disposition_updated_at: row.disposition_updated_at,
      sync_status: row.sync_status,
      // local_schedules 没有单独记录到达点位的列，跟 SqliteLocalScheduleReader 一致处理。
      recorded_location: null,
    };
  }

  public async write(scheduleId: string, state: ReminderRuntimeState): Promise<void> {
    if (this.target === null) return;
    await this.target.repository.updateReminderRuntime(
      this.target.accountId,
      scheduleId,
      toRuntimeUpdate(state),
    );
  }

  public async setDisposition(scheduleId: string, disposition: ReminderDisposition): Promise<void> {
    if (this.target === null) return;
    const current = await this.read(scheduleId);
    await this.target.repository.updateReminderRuntime(this.target.accountId, scheduleId, {
      reminder_disposition_state: disposition.state,
      next_trigger_at: current?.next_trigger_at ?? null,
      snoozed_until: disposition.snoozed_until,
      geofence_armed: (current?.geofence_armed ?? false) ? 1 : 0,
      disposition_updated_at: disposition.updated_at,
      sync_status: disposition.sync_status,
    });
  }
}

function toRuntimeUpdate(state: ReminderRuntimeState): LocalReminderRuntimeUpdate {
  return {
    reminder_disposition_state: state.reminder_disposition_state,
    next_trigger_at: state.next_trigger_at,
    snoozed_until: state.snoozed_until,
    geofence_armed: state.geofence_armed ? 1 : 0,
    disposition_updated_at: state.disposition_updated_at,
    sync_status: state.sync_status,
  };
}
