import { RRule, rrulestr } from 'rrule';

import { instantToZonedParts, localPartsToFloatingDate } from './scheduleDateTime';

const UTC_UNTIL_PATTERN = /(^|;)UNTIL=(\d{8}T\d{6}Z)(?=;|$)/gi;
const UTC_UNTIL_VALUE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** Adapt absolute UTC UNTIL values to the floating wall-clock coordinates used by rrule. */
export function normalizeUtcUntilForFloatingRrule(value: string, timezone: string): string {
  return value.replace(UTC_UNTIL_PATTERN, (component, prefix: string, untilValue: string) => {
    const instant = parseUtcUntil(untilValue);
    const floatingUntil = localPartsToFloatingDate(instantToZonedParts(instant, timezone));
    return `${prefix}UNTIL=${formatFloatingUntil(floatingUntil)}`;
  });
}

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

function parseUtcUntil(value: string): Date {
  const match = UTC_UNTIL_VALUE_PATTERN.exec(value.toUpperCase());
  if (match === null) {
    throw new TypeError('RRULE UNTIL must be a valid UTC date-time');
  }
  const components = match.slice(1).map(Number);
  const instant = new Date(
    Date.UTC(
      components[0],
      components[1] - 1,
      components[2],
      components[3],
      components[4],
      components[5],
    ),
  );
  if (
    instant.getUTCFullYear() !== components[0] ||
    instant.getUTCMonth() !== components[1] - 1 ||
    instant.getUTCDate() !== components[2] ||
    instant.getUTCHours() !== components[3] ||
    instant.getUTCMinutes() !== components[4] ||
    instant.getUTCSeconds() !== components[5]
  ) {
    throw new TypeError('RRULE UNTIL must be a valid UTC date-time');
  }
  return instant;
}

function formatFloatingUntil(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T${pad(
    value.getUTCHours(),
  )}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}
