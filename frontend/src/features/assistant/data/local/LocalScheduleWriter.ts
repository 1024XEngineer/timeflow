import { SCHEDULE_CATEGORIES, type ScheduleCategory } from '../../../../contracts/schedule';
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
 * 用 `operation` 显式排除 list_schedules：后端 create_schedule/update_schedule/
 * delete_schedule 三个操作共用同一条 `_mutation_result` 路径
 * （backend/src/timeflow/intelligence/realtime/schedule_tools.py:463），
 * `list_schedules`（查询，见同文件 `_find`）复用同一个 `schedules` 复数字段填
 * outcome——不能靠"字段是否存在"这种隐式判断排除它，query 结果不是已提交的写入，
 * 不能当成本地权威数据 upsert。删除是软删除，`status` 会变成 'deleted'，
 * `applyCloudSchedule` 照样按 id upsert，本地这行的 status 也跟着变成
 * 'deleted'，日历读服务只认 status==='active' 的行，自然就不显示了。
 *
 * 重复日程"仅删除这一次"命中已存在的 replace override 时（service.py 的
 * _delete_recurring_range），不产生新 override，而是让 `schedules` 里带上被
 * 连带软删的 replacement——`schedules` 复数字段是"这次命令落地的全部 schedule
 * 快照"，不是只服务查询场景；`occurrence_overrides` 跟 `schedules` 各自独立，
 * 一条 command.result 里两者都可能有、也可能都没有。
 *
 * 一条命令可能同时产生多条 schedule 写入和多条 override 写入，合起来才代表这条
 * 语音指令完整落地，所以全部包在一个事务里：任何一次写入失败（仓储返回 false，
 * 比如父日程缺失、账号不匹配）都会抛错并回滚整个事务，调用方据此不发
 * message.ack，不会向服务端谎报已落库、也不会在本地留下半吊子状态。
 */
export class LocalScheduleWriter implements LocalScheduleWriterPort {
  public constructor(private readonly repository: ScheduleLocalRepository) {}

  public async applyCommandResult(accountId: string, command: AppliedCommand): Promise<void> {
    if (command.status !== 'applied' || command.operation === 'list_schedules') {
      return;
    }
    const schedules = command.schedules ?? (command.schedule ? [command.schedule] : []);
    if (schedules.length === 0 && !command.occurrence_overrides?.length) {
      return;
    }
    await this.repository.withTransaction(async (repository) => {
      for (const raw of schedules) {
        const applied = await repository.applyCloudSchedule(toCloudScheduleRow(accountId, raw));
        if (!applied) {
          throw new Error(`Could not apply cloud schedule ${String(raw.id)}`);
        }
      }
      for (const override of command.occurrence_overrides ?? []) {
        const applied = await repository.upsertOccurrenceOverride(
          accountId,
          toOverrideRow(override),
        );
        if (!applied) {
          throw new Error(`Could not apply occurrence override ${override.id}`);
        }
      }
    });
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
    category: scheduleCategory(raw.category),
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

function toOverrideRow(override: AppliedOccurrenceOverride): LocalScheduleOccurrenceOverrideRow {
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

function scheduleCategory(value: unknown): CloudScheduleRow['category'] {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !SCHEDULE_CATEGORIES.includes(value as ScheduleCategory)) {
    throw new TypeError('command.result.schedule.category has an unsupported value');
  }
  return value as ScheduleCategory;
}
