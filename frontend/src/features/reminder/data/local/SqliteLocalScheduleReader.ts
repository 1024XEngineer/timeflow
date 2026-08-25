import type { ScheduleLocalRepository, LocalScheduleRow } from '../../../schedule/data';
import type { LocalScheduleReader } from '../../application/interfaces';
import type { LocalReminderSchedule, ReminderStrength } from '../../domain';
import { DEFAULT_GEOFENCE_RADIUS_METERS } from '../../domain/geofence';

type Target = { repository: ScheduleLocalRepository; accountId: string };

/**
 * 真实本地日程数据源：读 SQLite `local_schedules`，供 LocalReminderApplication 使用。
 *
 * createAppServices() 在认证/数据库就绪之前就要把这个类接进 reminderPorts，所以构造时
 * 不直接拿 repository/accountId——由调用方在数据库打开、账号确定后调用 attach()，
 * 账号切换或登出时调用 detach()。整个应用生命周期内只有这一个实例，
 * LocalReminderApplication.start() 对它的 subscribe() 只挂一次，重新绑定 target 不会
 * 让那次订阅失效。
 */
export class SqliteLocalScheduleReader implements LocalScheduleReader {
  private readonly listeners = new Set<(schedules: readonly LocalReminderSchedule[]) => void>();
  private target: Target | null = null;

  public attach(repository: ScheduleLocalRepository, accountId: string): void {
    this.target = { repository, accountId };
  }

  public detach(): void {
    this.target = null;
  }

  public async listReminderSchedules(): Promise<readonly LocalReminderSchedule[]> {
    if (this.target === null) return [];
    const rows = await this.target.repository.listSchedules(this.target.accountId);
    return rows.map(toLocalReminderSchedule);
  }

  public async getReminderSchedule(scheduleId: string): Promise<LocalReminderSchedule | null> {
    if (this.target === null) return null;
    const row = await this.target.repository.getSchedule(this.target.accountId, scheduleId);
    return row === null ? null : toLocalReminderSchedule(row);
  }

  public subscribe(listener: (schedules: readonly LocalReminderSchedule[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** attach() 之后或本地写入提交后调用：重新读取 SQLite 并通知订阅方触发 rebuild。 */
  public async refresh(): Promise<void> {
    const schedules = await this.listReminderSchedules();
    for (const listener of this.listeners) {
      listener(schedules);
    }
  }
}

function toLocalReminderSchedule(row: LocalScheduleRow): LocalReminderSchedule {
  return {
    id: row.id,
    account_id: row.account_id,
    title: row.title,
    schedule_type: row.schedule_type,
    schedule_kind: row.schedule_kind,
    is_all_day: row.is_all_day === 1,
    start_time: row.start_time,
    end_time: row.end_time,
    timezone: row.timezone,
    recurrence_rule: row.recurrence_rule,
    location_name: row.location_name,
    latitude: row.latitude,
    longitude: row.longitude,
    geofence_radius_meters: DEFAULT_GEOFENCE_RADIUS_METERS,
    reminder:
      row.reminder_type === null
        ? null
        : {
            reminder_type: row.reminder_type,
            reminder_trigger_at: row.reminder_trigger_at,
            reminder_offset_minutes: row.reminder_offset_minutes,
            // reminder_type 非空时 reminder_strength 一定非空，由建表 CHECK 约束保证。
            reminder_strength: row.reminder_strength as ReminderStrength,
          },
    runtime: {
      reminder_disposition_state: row.reminder_disposition_state,
      next_trigger_at: row.next_trigger_at,
      snoozed_until: row.snoozed_until,
      geofence_armed: row.geofence_armed === 1,
      disposition_updated_at: row.disposition_updated_at,
      sync_status: row.sync_status,
      // local_schedules 没有单独记录到达点位的列，围栏到达位置暂不持久化。
      recorded_location: null,
    },
    status: row.status,
    // 表里没有独立的设备端 revision 列，用 cloud_revision 兼当；这个字段在
    // reminder 领域逻辑里当前也没被读取。
    revision: row.cloud_revision,
    cloud_revision: row.cloud_revision,
    updated_at: row.updated_at,
  };
}
