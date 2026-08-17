import type { AppliedCommand } from '../../assistant/domain/ConversationTurn';

export interface CalendarFocusTarget {
  scheduleId: string;
  kind: 'time' | 'location';
  recurrenceMode: 'once' | 'recurring' | null;
  recurrenceRule: string | null;
  startTime: string | null;
  timezone: string | null;
}

export function calendarFocusTargetFromCommand(
  command: AppliedCommand | null,
): CalendarFocusTarget | null {
  if (command === null || command.status !== 'applied' || command.operation !== 'create_schedule') {
    return null;
  }
  const raw = command.schedule;
  if (raw === undefined || typeof raw.id !== 'string' || raw.id.length === 0) return null;

  const kind =
    raw.schedule_type === 'location' || typeof raw.start_time !== 'string' ? 'location' : 'time';
  const recurrenceMode =
    raw.schedule_kind === 'recurring' ? 'recurring' : raw.schedule_kind === 'once' ? 'once' : null;

  return {
    kind,
    recurrenceMode,
    recurrenceRule: typeof raw.recurrence_rule === 'string' ? raw.recurrence_rule : null,
    scheduleId: raw.id,
    startTime: typeof raw.start_time === 'string' ? raw.start_time : null,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : null,
  };
}
