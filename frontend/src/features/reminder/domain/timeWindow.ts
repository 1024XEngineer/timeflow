import {
  DEFAULT_SNOOZE_MINUTES,
  type LocalReminderSchedule,
  type ReminderConfiguration,
} from './reminder';

/** 以锚点时刻解析 at_time / before_start 触发时刻。 */
function resolveFromAnchor(reminder: ReminderConfiguration, anchorIso: string): string | null {
  if (reminder.reminder_type === 'before_start') {
    const offsetMinutes = reminder.reminder_offset_minutes ?? 0;
    const startMs = Date.parse(anchorIso);
    if (Number.isNaN(startMs)) return null;
    return new Date(startMs - offsetMinutes * 60_000).toISOString();
  }

  if (reminder.reminder_type === 'at_time') {
    return anchorIso;
  }

  return null;
}

/** 计算时间型提醒的应触发时刻（ISO）。无有效时间则返回 null。 */
export function resolveTimeTriggerAt(schedule: LocalReminderSchedule): string | null {
  const reminder = schedule.reminder;
  if (reminder == null) return null;

  // 重复日程必须用运行时 occurrence 光标；缺失时明确拒绝，避免回退到系列 start_time。
  if (schedule.schedule_kind === 'recurring') {
    const occurrenceAt = schedule.runtime.next_trigger_at;
    if (occurrenceAt == null) return null;
    return resolveFromAnchor(reminder, occurrenceAt);
  }

  if (reminder.reminder_trigger_at != null) {
    return reminder.reminder_trigger_at;
  }

  if (schedule.start_time == null) return null;
  return resolveFromAnchor(reminder, schedule.start_time);
}

/** 当前有效触发时刻：snooze 未结束时以 snoozed_until 为准。 */
export function resolveEffectiveTriggerAt(schedule: LocalReminderSchedule): string | null {
  if (
    schedule.runtime.reminder_disposition_state === 'snoozed' &&
    schedule.runtime.snoozed_until != null
  ) {
    return schedule.runtime.snoozed_until;
  }
  return resolveTimeTriggerAt(schedule);
}

export function resolveSnoozeUntil(
  nowIso: string,
  snoozeUntil: string | null | undefined,
  snoozeMinutes: number | null | undefined,
): string {
  if (snoozeUntil != null) return snoozeUntil;
  const minutes = snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES;
  const nowMs = Date.parse(nowIso);
  const base = Number.isNaN(nowMs) ? Date.now() : nowMs;
  return new Date(base + minutes * 60_000).toISOString();
}

export function isSnoozeActive(schedule: LocalReminderSchedule, nowIso: string): boolean {
  if (schedule.runtime.reminder_disposition_state !== 'snoozed') return false;
  const until = schedule.runtime.snoozed_until;
  if (until == null) return false;
  return Date.parse(nowIso) < Date.parse(until);
}

export function isTimeWindowReached(schedule: LocalReminderSchedule, nowIso: string): boolean {
  if (schedule.status !== 'active') return false;
  if (schedule.schedule_type !== 'time') return false;
  if (isSnoozeActive(schedule, nowIso)) return false;
  if (schedule.runtime.reminder_disposition_state === 'snoozed') return false;
  const triggerAt = resolveEffectiveTriggerAt(schedule);
  if (triggerAt == null) return false;
  return Date.parse(nowIso) >= Date.parse(triggerAt);
}

export function isSnoozeExpired(schedule: LocalReminderSchedule, nowIso: string): boolean {
  const until = schedule.runtime.snoozed_until;
  if (until == null) return false;
  if (schedule.runtime.reminder_disposition_state !== 'snoozed') return false;
  return Date.parse(nowIso) >= Date.parse(until);
}
