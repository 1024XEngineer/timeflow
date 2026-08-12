"""RRULE validation and occurrence selection for schedule use cases."""

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.rrule import rrule, rrulebase, rrulestr

from timeflow.business.calendar.contracts import (
    OccurrenceOverrideAction,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
)


class InvalidRecurrenceRuleError(ValueError):
    """A recurrence rule cannot be expanded from its schedule start."""


class InvalidTimezoneKeyError(ValueError):
    """A schedule timezone is not a valid IANA key."""


def get_schedule_timezone(key: str) -> ZoneInfo:
    """Return an IANA timezone while normalizing known invalid-key failures."""
    try:
        return ZoneInfo(key)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise InvalidTimezoneKeyError(key) from exc


def normalize_recurrence_rule(rule: str) -> str:
    """Return the canonical body of exactly one RRULE.

    The shared contract stores an RRULE body such as ``FREQ=WEEKLY;BYDAY=MO``.
    A single legacy-style ``RRULE:`` prefix is accepted and removed, while
    recurrence sets, content lines, and embedded DTSTART/RDATE/EXDATE data are
    rejected before dateutil parses the rule body.
    """
    normalized = rule.strip()
    if not normalized or "\n" in normalized or "\r" in normalized:
        raise InvalidRecurrenceRuleError("recurrence_rule must contain one RRULE")
    if normalized[:6].upper() == "RRULE:":
        normalized = normalized[6:]
    if not normalized or ":" in normalized:
        raise InvalidRecurrenceRuleError("recurrence_rule must contain only one RRULE body")
    return normalized


def parse_recurrence_rule(rule: str, *, start_time: datetime) -> rrulebase:
    """Parse one RFC 5545 RRULE using the schedule start as DTSTART."""
    normalized = normalize_recurrence_rule(rule)
    try:
        parsed = rrulestr(normalized, dtstart=start_time)
        if not isinstance(parsed, rrule):
            raise InvalidRecurrenceRuleError("recurrence_rule must contain exactly one RRULE")
        first = parsed.after(start_time, inc=True)
    except (TypeError, ValueError, OverflowError) as exc:
        raise InvalidRecurrenceRuleError("recurrence_rule is not a valid RFC 5545 RRULE") from exc
    if first is None:
        raise InvalidRecurrenceRuleError("recurrence_rule has no occurrence at or after start_time")
    return parsed


def first_active_occurrence_on_or_after_local_date(
    schedule: ScheduleSnapshot,
    *,
    now: datetime,
    overrides: tuple[ScheduleOccurrenceOverrideSnapshot, ...],
) -> datetime | None:
    """Return the first non-cancelled original occurrence from today's local date.

    A replaced occurrence still belongs to the recurring series at its original
    start. Deletion scope must therefore be able to select it even though normal
    calendar expansion displays its replacement schedule instead.
    """
    if schedule.start_time is None or schedule.recurrence_rule is None:
        return None
    timezone = get_schedule_timezone(schedule.timezone)
    local_start = schedule.start_time.astimezone(timezone)
    local_date = now.astimezone(timezone).date()
    boundary = datetime.combine(local_date, time.min, tzinfo=timezone)
    rule = parse_recurrence_rule(schedule.recurrence_rule, start_time=local_start)
    cancelled = {
        override.occurrence_start
        for override in overrides
        if override.action is OccurrenceOverrideAction.CANCEL
    }
    occurrence = rule.after(boundary, inc=True)
    while occurrence is not None and occurrence in cancelled:
        occurrence = rule.after(occurrence, inc=False)
    return None if occurrence is None else occurrence.astimezone(UTC)


def first_occurrence_in_window(
    schedule: ScheduleSnapshot,
    *,
    starts_at_or_after: datetime | None,
    starts_before: datetime | None,
    excluded_occurrence_starts: frozenset[datetime],
) -> datetime | None:
    """Find one non-overridden occurrence in a half-open query window.

    ``after``/``before`` jump directly to the window edge. Iteration advances
    only when that occurrence has an override, rather than replaying history
    from the schedule start.
    """
    if schedule.start_time is None or schedule.recurrence_rule is None:
        return None
    timezone = get_schedule_timezone(schedule.timezone)
    local_start = schedule.start_time.astimezone(timezone)
    rule = parse_recurrence_rule(schedule.recurrence_rule, start_time=local_start)
    local_lower = None if starts_at_or_after is None else starts_at_or_after.astimezone(timezone)
    local_upper = None if starts_before is None else starts_before.astimezone(timezone)

    if local_lower is not None:
        occurrence = rule.after(local_lower, inc=True)
        while occurrence is not None and (local_upper is None or occurrence < local_upper):
            utc_occurrence = occurrence.astimezone(UTC)
            if utc_occurrence not in excluded_occurrence_starts:
                return utc_occurrence
            occurrence = rule.after(occurrence, inc=False)
        return None

    if local_upper is None:
        return None
    occurrence = rule.before(local_upper, inc=False)
    while occurrence is not None and occurrence >= local_start:
        utc_occurrence = occurrence.astimezone(UTC)
        if utc_occurrence not in excluded_occurrence_starts:
            return utc_occurrence
        occurrence = rule.before(occurrence, inc=False)
    return None


def truncate_rule_before_occurrence(
    schedule: ScheduleSnapshot,
    occurrence: datetime,
) -> str | None:
    """Return an RRULE ending at the prior occurrence, or None for the first one."""
    if schedule.start_time is None or schedule.recurrence_rule is None:
        return None
    timezone = get_schedule_timezone(schedule.timezone)
    local_start = schedule.start_time.astimezone(timezone)
    local_occurrence = occurrence.astimezone(timezone)
    rule = parse_recurrence_rule(schedule.recurrence_rule, start_time=local_start)
    previous = rule.before(local_occurrence, inc=False)
    if previous is None:
        return None

    components = [
        component
        for component in normalize_recurrence_rule(schedule.recurrence_rule).split(";")
        if not component.upper().startswith(("UNTIL=", "COUNT="))
    ]
    until = previous.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    truncated = ";".join((*components, f"UNTIL={until}"))
    parse_recurrence_rule(truncated, start_time=local_start)
    return truncated


__all__ = [
    "InvalidRecurrenceRuleError",
    "InvalidTimezoneKeyError",
    "first_active_occurrence_on_or_after_local_date",
    "first_occurrence_in_window",
    "get_schedule_timezone",
    "normalize_recurrence_rule",
    "parse_recurrence_rule",
    "truncate_rule_before_occurrence",
]
