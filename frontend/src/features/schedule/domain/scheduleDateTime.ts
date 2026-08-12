export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A requested wall-clock value falls inside an IANA timezone's forward DST gap. */
export class NonexistentLocalTimeError extends RangeError {}

export function isValidIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function parseIsoInstant(value: string | null): Date | null {
  if (value === null || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseDateOnly(value: string): LocalDateTimeParts | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

export function addLocalDays(parts: LocalDateTimeParts, days: number): LocalDateTimeParts {
  const value = new Date(localPartsToFloatingDate(parts).getTime() + days * 86_400_000);
  return floatingDateToLocalParts(value);
}

export function instantToZonedParts(instant: Date, timezone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
    millisecond: instant.getUTCMilliseconds(),
  };
}

export function zonedPartsToInstant(parts: LocalDateTimeParts, timezone: string): Date {
  const wanted = localPartsToFloatingDate(parts).getTime();
  let candidate = wanted;
  let resolved: Date | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = localPartsToFloatingDate(
      instantToZonedParts(new Date(candidate), timezone),
    ).getTime();
    const correction = wanted - represented;
    candidate += correction;
    if (correction === 0) {
      resolved = new Date(candidate);
      break;
    }
  }
  if (resolved === null || !sameLocalParts(instantToZonedParts(resolved, timezone), parts)) {
    throw new NonexistentLocalTimeError(`Local time does not exist in IANA timezone ${timezone}`);
  }
  return selectEarlierAmbiguousInstant(parts, timezone, resolved);
}

export function localPartsToFloatingDate(parts: LocalDateTimeParts): Date {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ),
  );
}

export function floatingDateToLocalParts(value: Date): LocalDateTimeParts {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
    second: value.getUTCSeconds(),
    millisecond: value.getUTCMilliseconds(),
  };
}

function sameLocalParts(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

function selectEarlierAmbiguousInstant(
  parts: LocalDateTimeParts,
  timezone: string,
  resolved: Date,
): Date {
  const wanted = localPartsToFloatingDate(parts).getTime();
  const offsets = new Set(
    [-86_400_000, 0, 86_400_000].map((delta) => timezoneOffsetAt(resolved, timezone, delta)),
  );
  const candidates = [...offsets]
    .map((offset) => new Date(wanted - offset))
    .filter((candidate) => sameLocalParts(instantToZonedParts(candidate, timezone), parts));
  return candidates.reduce(
    (earlier, candidate) => (candidate < earlier ? candidate : earlier),
    resolved,
  );
}

function timezoneOffsetAt(resolved: Date, timezone: string, delta: number): number {
  const instant = new Date(resolved.getTime() + delta);
  return (
    localPartsToFloatingDate(instantToZonedParts(instant, timezone)).getTime() - instant.getTime()
  );
}
