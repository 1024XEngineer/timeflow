import type { SQLiteDatabase } from 'expo-sqlite';

import { withDatabaseAccess } from '../../../../infrastructure/database/accessGate';
import type {
  ReminderDispositionState,
  ReminderStrength,
  ReminderSyncStatus,
  ReminderType,
} from '../../../../contracts/reminder';
import type {
  OccurrenceOverrideAction,
  ReminderDispositionState as CloudReminderDispositionState,
  ScheduleCategory,
  ScheduleKind,
  ScheduleStatus,
  ScheduleType,
} from '../../../../contracts/schedule';

export type LocalReminderDispositionState = ReminderDispositionState;
export type LocalReminderSyncStatus = ReminderSyncStatus;

export interface CloudScheduleRow {
  id: string;
  account_id: string;
  schedule_type: ScheduleType;
  schedule_kind: ScheduleKind;
  category: ScheduleCategory | null;
  title: string;
  is_all_day: 0 | 1;
  start_time: string | null;
  end_time: string | null;
  timezone: string;
  recurrence_rule: string | null;
  location_name: string | null;
  latitude: number | null;
  longitude: number | null;
  reminder_type: ReminderType | null;
  reminder_trigger_at: string | null;
  reminder_offset_minutes: number | null;
  reminder_strength: ReminderStrength | null;
  reminder_disposition_state: CloudReminderDispositionState | null;
  status: ScheduleStatus;
  cloud_revision: number;
  updated_at: string;
}

export interface LocalScheduleRow extends Omit<CloudScheduleRow, 'reminder_disposition_state'> {
  reminder_disposition_state: LocalReminderDispositionState | null;
  next_trigger_at: string | null;
  snoozed_until: string | null;
  geofence_armed: 0 | 1;
  disposition_updated_at: string | null;
  sync_status: LocalReminderSyncStatus;
}

export type LocalReminderRuntimeUpdate = Pick<
  LocalScheduleRow,
  | 'reminder_disposition_state'
  | 'next_trigger_at'
  | 'snoozed_until'
  | 'geofence_armed'
  | 'disposition_updated_at'
  | 'sync_status'
>;

export interface LocalScheduleOccurrenceOverrideRow {
  id: string;
  schedule_id: string;
  occurrence_start: string;
  action: OccurrenceOverrideAction;
  replacement_schedule_id: string | null;
}

/**
 * 每个公开方法都经过 withDatabaseAccess 排队。全应用共用同一条 SQLite 连接，
 * 事务里的 BEGIN/COMMIT 是连接级的，不排队的话事务进行中别的读写会被卷进这个
 * 事务、或者两个事务重叠直接报错。
 *
 * insideGate 给"调用方已经持有队列"的场景用（事务内部、或 scheduleSyncService
 * 那种整段包在队列里的代码）：这些方法不能再去排一次队，否则等的是调用方自己
 * 持有的那把锁，直接死锁。队列本身故意做成不可重入的，所以这件事必须由调用方
 * 显式传进来，不靠全局标志推断——推断在 await 间隙会把无关调用方一起放行。
 */
export class ScheduleLocalRepository {
  public constructor(
    private readonly database: SQLiteDatabase,
    private readonly insideGate = false,
  ) {}

  private run<T>(work: () => Promise<T>): Promise<T> {
    return this.insideGate ? work() : withDatabaseAccess(work);
  }

  public async countSchedules(accountId: string): Promise<number> {
    return this.run(async () => {
      const row = await this.database.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM local_schedules WHERE account_id = ?',
        accountId,
      );
      return row?.count ?? 0;
    });
  }

  public getSchedule(accountId: string, scheduleId: string): Promise<LocalScheduleRow | null> {
    return this.run(() =>
      this.database.getFirstAsync<LocalScheduleRow>(
        `SELECT * FROM local_schedules WHERE account_id = ? AND id = ?`,
        accountId,
        scheduleId,
      ),
    );
  }

  public listSchedules(accountId: string): Promise<LocalScheduleRow[]> {
    return this.run(() =>
      this.database.getAllAsync<LocalScheduleRow>(
        `SELECT *
       FROM local_schedules
       WHERE account_id = ?
       ORDER BY start_time, updated_at, id`,
        accountId,
      ),
    );
  }

  /**
   * 一批相关写入要么全部生效、要么全部不生效——用 withTransactionAsync 而不是
   * withExclusiveTransactionAsync：后者每次调用都会在原生层开一条全新的独立连接，
   * 而重复打开同一个库正是把主会话连接弄废的那个坑（详见
   * infrastructure/database/sqlite.ts），退一步说两条连接抢同一把排他锁也会让写入
   * 静默失败（"database is locked"，AssistantConversationService 那边有一个回归测试
   * 记录过）。改成在共享连接上跑 BEGIN/COMMIT，用上面的排队保证互斥。
   */
  public async withTransaction<T>(
    task: (repository: ScheduleLocalRepository) => Promise<T>,
  ): Promise<T> {
    return this.run(async () => {
      // 传进去的是标记了 insideGate 的实例：队列这一刻正被本方法持有，task 里
      // 的仓储调用如果再去排队，等的就是自己持有的锁。
      const inGate = new ScheduleLocalRepository(this.database, true);
      let result!: T;
      await this.database.withTransactionAsync(async () => {
        result = await task(inGate);
      });
      return result;
    });
  }

  /** Apply cloud-owned fields while preserving existing device runtime state. */
  public async applyCloudSchedule(row: CloudScheduleRow): Promise<boolean> {
    return this.run(async () => {
      const result = await this.database.runAsync(
        `INSERT INTO local_schedules (
         id, account_id, schedule_type, schedule_kind, category, title, is_all_day,
         start_time, end_time, timezone, recurrence_rule, location_name,
         latitude, longitude, reminder_type, reminder_trigger_at,
         reminder_offset_minutes, reminder_strength, reminder_disposition_state,
         next_trigger_at, snoozed_until, geofence_armed, disposition_updated_at,
         sync_status, status, cloud_revision, updated_at
       ) VALUES (
         $id, $account_id, $schedule_type, $schedule_kind, $category, $title, $is_all_day,
         $start_time, $end_time, $timezone, $recurrence_rule, $location_name,
         $latitude, $longitude, $reminder_type, $reminder_trigger_at,
         $reminder_offset_minutes, $reminder_strength, $reminder_disposition_state,
         NULL, NULL, 0, NULL, 'synced', $status, $cloud_revision, $updated_at
       )
       ON CONFLICT(id) DO UPDATE SET
         schedule_type = excluded.schedule_type,
         schedule_kind = excluded.schedule_kind,
         category = excluded.category,
         title = excluded.title,
         is_all_day = excluded.is_all_day,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         timezone = excluded.timezone,
         recurrence_rule = excluded.recurrence_rule,
         location_name = excluded.location_name,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         reminder_type = excluded.reminder_type,
         reminder_trigger_at = excluded.reminder_trigger_at,
         reminder_offset_minutes = excluded.reminder_offset_minutes,
         reminder_strength = excluded.reminder_strength,
         status = excluded.status,
         cloud_revision = excluded.cloud_revision,
         updated_at = excluded.updated_at
       WHERE local_schedules.account_id = excluded.account_id`,
        {
          $id: row.id,
          $account_id: row.account_id,
          $schedule_type: row.schedule_type,
          $schedule_kind: row.schedule_kind,
          $category: row.category,
          $title: row.title,
          $is_all_day: row.is_all_day,
          $start_time: row.start_time,
          $end_time: row.end_time,
          $timezone: row.timezone,
          $recurrence_rule: row.recurrence_rule,
          $location_name: row.location_name,
          $latitude: row.latitude,
          $longitude: row.longitude,
          $reminder_type: row.reminder_type,
          $reminder_trigger_at: row.reminder_trigger_at,
          $reminder_offset_minutes: row.reminder_offset_minutes,
          $reminder_strength: row.reminder_strength,
          $reminder_disposition_state: row.reminder_disposition_state,
          $status: row.status,
          $cloud_revision: row.cloud_revision,
          $updated_at: row.updated_at,
        },
      );
      return result.changes === 1;
    });
  }

  /** Patch only the asynchronously classified category; cloud revision is untouched. */
  public async patchScheduleCategory(
    accountId: string,
    scheduleId: string,
    category: ScheduleCategory,
  ): Promise<boolean> {
    return this.run(async () => {
      const result = await this.database.runAsync(
        `UPDATE local_schedules
       SET category = ?
       WHERE account_id = ? AND id = ? AND status = 'active'`,
        category,
        accountId,
        scheduleId,
      );
      return result.changes === 1;
    });
  }

  /** Update only reminder state owned by the current device. */
  public async updateReminderRuntime(
    accountId: string,
    scheduleId: string,
    runtime: LocalReminderRuntimeUpdate,
  ): Promise<boolean> {
    return this.run(async () => {
      const result = await this.database.runAsync(
        `UPDATE local_schedules SET
         reminder_disposition_state = $reminder_disposition_state,
         next_trigger_at = $next_trigger_at,
         snoozed_until = $snoozed_until,
         geofence_armed = $geofence_armed,
         disposition_updated_at = $disposition_updated_at,
         sync_status = $sync_status
       WHERE account_id = $account_id AND id = $id`,
        {
          $account_id: accountId,
          $id: scheduleId,
          $reminder_disposition_state: runtime.reminder_disposition_state,
          $next_trigger_at: runtime.next_trigger_at,
          $snoozed_until: runtime.snoozed_until,
          $geofence_armed: runtime.geofence_armed,
          $disposition_updated_at: runtime.disposition_updated_at,
          $sync_status: runtime.sync_status,
        },
      );
      return result.changes === 1;
    });
  }

  /** Physically remove one local row for recovery or maintenance cleanup only. */
  public async purgeSchedule(accountId: string, scheduleId: string): Promise<boolean> {
    return this.run(async () => {
      const result = await this.database.runAsync(
        `DELETE FROM local_schedules WHERE account_id = ? AND id = ?`,
        accountId,
        scheduleId,
      );
      return result.changes === 1;
    });
  }

  public async upsertOccurrenceOverride(
    accountId: string,
    row: LocalScheduleOccurrenceOverrideRow,
  ): Promise<boolean> {
    return this.run(async () => {
      const owner = await this.database.getFirstAsync<{ id: string }>(
        `SELECT id FROM local_schedules WHERE account_id = ? AND id = ?`,
        accountId,
        row.schedule_id,
      );
      if (owner === null) {
        return false;
      }
      if (row.replacement_schedule_id !== null) {
        const replacementOwner = await this.database.getFirstAsync<{ id: string }>(
          `SELECT id FROM local_schedules WHERE account_id = ? AND id = ?`,
          accountId,
          row.replacement_schedule_id,
        );
        if (replacementOwner === null) {
          return false;
        }
      }

      const result = await this.database.runAsync(
        `INSERT INTO local_schedule_occurrence_overrides (
         id, schedule_id, occurrence_start, action, replacement_schedule_id
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         occurrence_start = excluded.occurrence_start,
         action = excluded.action,
         replacement_schedule_id = excluded.replacement_schedule_id
       WHERE schedule_id = excluded.schedule_id`,
        row.id,
        row.schedule_id,
        row.occurrence_start,
        row.action,
        row.replacement_schedule_id,
      );
      return result.changes === 1;
    });
  }

  public listOccurrenceOverrides(
    accountId: string,
    scheduleId?: string,
  ): Promise<LocalScheduleOccurrenceOverrideRow[]> {
    const scheduleFilter = scheduleId === undefined ? '' : 'AND overrides.schedule_id = ?';
    const parameters = scheduleId === undefined ? [accountId] : [accountId, scheduleId];
    return this.run(() =>
      this.database.getAllAsync<LocalScheduleOccurrenceOverrideRow>(
        `SELECT
         overrides.id,
         overrides.schedule_id,
         overrides.occurrence_start,
         overrides.action,
         overrides.replacement_schedule_id
       FROM local_schedule_occurrence_overrides AS overrides
       INNER JOIN local_schedules AS schedules ON schedules.id = overrides.schedule_id
       WHERE schedules.account_id = ? ${scheduleFilter}
       ORDER BY overrides.occurrence_start, overrides.id`,
        parameters,
      ),
    );
  }
}
