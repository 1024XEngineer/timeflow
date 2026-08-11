"""RRULE validation and occurrence selection for schedule use cases."""

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.rrule import rrulebase, rrulestr

from timeflow.business.calendar.contracts import (
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
)


class InvalidRecurrenceRuleError(ValueError):
    """A recurrence rule cannot be expanded from its schedule start."""


def parse_recurrence_rule(rule: str, *, start_time: datetime) -> rrulebase:
    """Parse one RFC 5545 RRULE using the schedule start as DTSTART."""
    if not rule.strip() or "\n" in rule or "\r" in rule:
        raise InvalidRecurrenceRuleError("recurrence_rule must contain one RRULE")
    try:
        parsed = rrulestr(rule, dtstart=start_time)
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
    """Return the first non-overridden occurrence on/after today's local date."""
    if schedule.start_time is None or schedule.recurrence_rule is None:
        return None
    try:
        timezone = ZoneInfo(schedule.timezone)
    except ZoneInfoNotFoundError:
        return None
    local_date = now.astimezone(timezone).date()
    boundary = datetime.combine(local_date, time.min, tzinfo=timezone)
    rule = parse_recurrence_rule(schedule.recurrence_rule, start_time=schedule.start_time)
    overridden = {override.occurrence_start for override in overrides}
    occurrence = rule.after(boundary, inc=True)
    while occurrence is not None and occurrence in overridden:
        occurrence = rule.after(occurrence, inc=False)
    return occurrence


def truncate_rule_before_occurrence(
    schedule: ScheduleSnapshot,
    occurrence: datetime,
) -> str | None:
    """Return an RRULE ending at the prior occurrence, or None for the first one."""
    if schedule.start_time is None or schedule.recurrence_rule is None:
        return None
    rule = parse_recurrence_rule(schedule.recurrence_rule, start_time=schedule.start_time)
    previous = rule.before(occurrence, inc=False)
    if previous is None:
        return None

    components = [
        component
        for component in schedule.recurrence_rule.split(";")
        if not component.upper().startswith(("UNTIL=", "COUNT="))
    ]
    until = previous.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    truncated = ";".join((*components, f"UNTIL={until}"))
    parse_recurrence_rule(truncated, start_time=schedule.start_time)
    return truncated


__all__ = [
    "InvalidRecurrenceRuleError",
    "first_active_occurrence_on_or_after_local_date",
    "parse_recurrence_rule",
    "truncate_rule_before_occurrence",
]
