import { RRule, rrulestr } from 'rrule';

/** Parse exactly one RRULE body with a caller-supplied floating local DTSTART. */
export function parseScheduleRrule(value: string, dtstart: Date): RRule {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
    throw new TypeError('RRULE must contain exactly one rule');
  }
  const body = trimmed.toUpperCase().startsWith('RRULE:') ? trimmed.slice(6) : trimmed;
  if (body.length === 0 || body.includes(':')) {
    throw new TypeError('RRULE must contain only one rule body');
  }
  const parsed = rrulestr(body, { dtstart });
  if (!(parsed instanceof RRule)) {
    throw new TypeError('RRULE must resolve to one rule');
  }
  return parsed;
}
