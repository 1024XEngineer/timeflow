import type {
  CloudScheduleRow,
  LocalScheduleOccurrenceOverrideRow,
  ScheduleLocalRepository,
} from '../../../schedule/data';
import type { LocalScheduleWriterPort } from '../../application/interfaces/LocalScheduleWriterPort';
import type { AppliedCommand, AppliedOccurrenceOverride } from '../../domain/ConversationTurn';

/**
 * `applyCloudSchedule` 是仓储里现成的 upsert，专门给"服务端权威数据落到本地"用的
 * （固定写 sync_status='synced'），voice.command.result 正好是这种场景——服务端
 * 已经提交过了，这里只是把它同步进本地日历读服务能看到的地方。
 *
 * 不按 operation 名字判断该不该写：后端 create_schedule/update_schedule/
 * delete_schedule 三个操作共用同一条 `_mutation_result` 路径
 * （backend/src/timeflow/intelligence/realtime/schedule_tools.py:384），
 * `schedule` 字段结构完全一样——删除是软删除，`status` 会变成 'deleted'，
 * `applyCloudSchedule` 照样按 id upsert，本地这行的 status 也跟着变成
 * 'deleted'，日历读服务只认 status==='active' 的行，自然就不显示了。只要
 * `schedule` 字段存在就同步，这样天然排除 list_schedules（只有 `schedules`
 * 复数字段，没有 `schedule`）。
 *
 * 重复日程"仅删除这一次"（service.py 的 _delete_recurring_range 里创建
 * occurrence_override 那条分支）不产生新的 schedule 快照，只产生一条
 * override；`occurrence_overrides` 跟 `schedule` 各自独立处理，一条
 * command.result 里两者都可能有、也可能都没有。
 */
export class LocalScheduleWriter implements LocalScheduleWriterPort {
  public constructor(private readonly repository: ScheduleLocalRepository) {}

  public async applyCommandResult(accountId: string, command: AppliedCommand): Promise<void> {
    if (command.status !== 'applied' || (!command.schedule && !command.occurrence_overrides)) {
      return;
    }
    if (command.schedule) {
      await this.repository.applyCloudSchedule(toCloudScheduleRow(accountId, command.schedule));
    }
    for (const override of command.occurrence_overrides ?? []) {
      await this.repository.upsertOccurrenceOverride(accountId, toOverrideRow(override));
    }
  }
}

function toCloudScheduleRow(accountId: string, raw: Record<string, unknown>): CloudScheduleRow {
  return {
    id: requireString(raw.id, 'id'),
    account_id: accountId,
    schedule_type: requireString(
      raw.schedule_type,
      'schedule_type',
    ) as CloudScheduleRow['schedule_type'],
    schedule_kind: requireString(
      raw.schedule_kind,
      'schedule_kind',
    ) as CloudScheduleRow['schedule_kind'],
    title: requireString(raw.title, 'title'),
    is_all_day: raw.is_all_day === true ? 1 : 0,
    start_time: optionalString(raw.start_time),
    end_time: optionalString(raw.end_time),
    timezone: requireString(raw.timezone, 'timezone'),
    recurrence_rule: optionalString(raw.recurrence_rule),
    location_name: optionalString(raw.location_name),
    latitude: optionalNumber(raw.latitude),
    longitude: optionalNumber(raw.longitude),
    reminder_type: optionalString(raw.reminder_type) as CloudScheduleRow['reminder_type'],
    reminder_trigger_at: optionalString(raw.reminder_trigger_at),
    reminder_offset_minutes: optionalNumber(raw.reminder_offset_minutes),
    reminder_strength: optionalString(
      raw.reminder_strength,
    ) as CloudScheduleRow['reminder_strength'],
    reminder_disposition_state: optionalString(raw.reminder_disposition_state) as
      CloudScheduleRow['reminder_disposition_state'] | null,
    status: (optionalString(raw.status) ?? 'active') as CloudScheduleRow['status'],
    cloud_revision: optionalNumber(raw.revision) ?? 1,
    // 服务端的 schedule 字典过滤掉了 updated_at（_snapshot_for_client），用写入
    // 这一刻的时间：这条记录确实就是此刻被服务端确认、同步到本地的。
    updated_at: new Date().toISOString(),
  };
}

function toOverrideRow(
  override: AppliedOccurrenceOverride,
): LocalScheduleOccurrenceOverrideRow {
  return {
    id: override.id,
    schedule_id: override.schedule_id,
    occurrence_start: override.occurrence_start,
    action: override.action,
    replacement_schedule_id: override.replacement_schedule_id,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`command.result.schedule.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
