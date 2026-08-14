import type {
  LocalReminderRuntimeUpdate,
  LocalScheduleRow,
  ScheduleLocalRepository,
} from '../../../schedule/data';
import {
  floatingDateToLocalParts,
  instantToZonedParts,
  isValidIanaTimezone,
  localPartsToFloatingDate,
  zonedPartsToInstant,
} from '../../../schedule/domain/scheduleDateTime';
import {
  normalizeUtcUntilForFloatingRrule,
  parseScheduleRrule,
} from '../../../schedule/domain/scheduleRecurrence';
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

    // 重复日程的 occurrence 光标为空：要么是云端刚同步下来的新记录（从没落过库），
    // 要么是上一次 occurrence 被 confirmInternal 消费后显式清空的（它就是靠置空
    // next_trigger_at 触发"这条该往前挪一格了"）。resolveTimeTriggerAt() 对重复
    // 日程光标为空时明确返回 null，不会回退到系列 start_time，所以这里必须补上
    // 下一次发生时间，不然这条提醒永远不会再触发第二次。同时把上一轮的
    // disposition 状态一起重置，否则 canDeliver() 会因为它还是 'confirmed' 继续
    // 拦住这条全新的 occurrence。
    if (row.schedule_kind === 'recurring' && row.next_trigger_at === null) {
      const nextOccurrence = nextRecurringOccurrenceAtOrAfter(row, new Date());
      if (nextOccurrence !== null) {
        return {
          reminder_disposition_state: null,
          next_trigger_at: nextOccurrence,
          snoozed_until: null,
          geofence_armed: row.geofence_armed === 1,
          disposition_updated_at: null,
          sync_status: row.sync_status,
          recorded_location: null,
        };
      }
      // 系列已经结束（RRULE 的 UNTIL/COUNT 用完了）或规则本身有问题：没有下一次
      // 发生时间可算，透传原始（空）状态，让上层照常按"这条排不上"处理。
    }

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

/** 重复日程从 now 起（含 now 本身）的下一次发生时间；规则用完/无效时返回 null。 */
function nextRecurringOccurrenceAtOrAfter(row: LocalScheduleRow, now: Date): string | null {
  if (row.start_time === null || row.recurrence_rule === null) return null;
  if (!isValidIanaTimezone(row.timezone)) return null;

  try {
    const floatingStart = localPartsToFloatingDate(
      instantToZonedParts(new Date(row.start_time), row.timezone),
    );
    const rule = parseScheduleRrule(
      normalizeUtcUntilForFloatingRrule(row.recurrence_rule, row.timezone),
      floatingStart,
    );
    const floatingNow = localPartsToFloatingDate(instantToZonedParts(now, row.timezone));
    const nextFloating = rule.after(floatingNow, true);
    if (nextFloating === null) return null;
    return zonedPartsToInstant(floatingDateToLocalParts(nextFloating), row.timezone).toISOString();
  } catch {
    return null;
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
