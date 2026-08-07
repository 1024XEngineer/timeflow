"""Framework-independent contracts for the schedule business boundary."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TypeAlias


class ScheduleType(str, Enum):
    """Supported schedule categories."""

    TIME = "time"
    LOCATION = "location"


class ScheduleKind(str, Enum):
    """Whether a schedule occurs once or follows an RRULE."""

    ONCE = "once"
    RECURRING = "recurring"


class ScheduleStatus(str, Enum):
    """Cloud lifecycle status for a schedule."""

    ACTIVE = "active"
    DELETED = "deleted"


class ReminderType(str, Enum):
    """The single reminder configuration attached to a schedule."""

    AT_TIME = "at_time"
    BEFORE_START = "before_start"
    ARRIVE_LOCATION = "arrive_location"
    RETURN_TO_RECORDED_LOCATION = "return_to_recorded_location"


class ReminderStrength(str, Enum):
    """Reminder delivery strength selected for a schedule."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class RecurringDeleteScope(str, Enum):
    """Deletion scopes based on the schedule-local current date.

    The implementation must derive the current date from the schedule's IANA
    timezone. It then finds the first occurrence whose local date is today or
    later; the caller cannot provide an arbitrary occurrence date.
    """

    NEXT_OCCURRENCE = "next_occurrence"
    NEXT_AND_FUTURE = "next_and_future"


class OccurrenceOverrideAction(str, Enum):
    """Supported changes to one expanded recurring occurrence."""

    CANCEL = "cancel"
    REPLACE = "replace"


SchedulePatchValue: TypeAlias = str | bool | int | float | datetime | None


@dataclass(frozen=True, slots=True)
class ScheduleSnapshot:
    """A final schedule snapshot committed by the cloud service."""

    id: str
    account_id: str
    schedule_type: ScheduleType
    schedule_kind: ScheduleKind
    title: str
    is_all_day: bool
    timezone: str
    status: ScheduleStatus
    revision: int
    created_at: datetime
    updated_at: datetime
    start_time: datetime | None = None
    end_time: datetime | None = None
    recurrence_rule: str | None = None
    location_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    reminder_type: ReminderType | None = None
    reminder_trigger_at: datetime | None = None
    reminder_offset_minutes: int | None = None
    reminder_strength: ReminderStrength | None = None
    reminder_disposition_state: str | None = None
    deleted_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ScheduleOccurrenceOverrideSnapshot:
    """A committed exception for one recurring occurrence."""

    id: str
    schedule_id: str
    occurrence_start: datetime
    action: OccurrenceOverrideAction
    created_at: datetime
    updated_at: datetime
    replacement_schedule_id: str | None = None


@dataclass(frozen=True, slots=True)
class CreateScheduleCommand:
    """Structured, user-confirmed input used to create a schedule."""

    schedule_type: ScheduleType
    schedule_kind: ScheduleKind
    title: str
    timezone: str
    is_all_day: bool = False
    start_time: datetime | None = None
    end_time: datetime | None = None
    recurrence_rule: str | None = None
    location_name: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    reminder_type: ReminderType | None = None
    reminder_trigger_at: datetime | None = None
    reminder_offset_minutes: int | None = None
    reminder_strength: ReminderStrength | None = None


@dataclass(frozen=True, slots=True)
class FindSchedulesQuery:
    """Search criteria supplied by the Agent for matching schedules."""

    schedule_id: str | None = None
    title: str | None = None
    starts_at_or_after: datetime | None = None
    starts_before: datetime | None = None
    location_name: str | None = None
    include_deleted: bool = False


@dataclass(frozen=True, slots=True)
class UpdateScheduleCommand:
    """A confirmed patch applied to one schedule or an entire recurring series."""

    schedule_id: str
    expected_revision: int
    changes: Mapping[str, SchedulePatchValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DeleteOnceScheduleCommand:
    """A confirmed request to soft-delete one non-recurring schedule."""

    schedule_id: str
    expected_revision: int


@dataclass(frozen=True, slots=True)
class DeleteRecurringScheduleCommand:
    """A confirmed request to delete the next recurring occurrence or its future."""

    schedule_id: str
    expected_revision: int
    scope: RecurringDeleteScope


@dataclass(frozen=True, slots=True)
class ScheduleMutationResult:
    """Final cloud snapshots produced by a successful mutation."""

    schedules: tuple[ScheduleSnapshot, ...]
    occurrence_overrides: tuple[ScheduleOccurrenceOverrideSnapshot, ...] = ()


@dataclass(frozen=True, slots=True)
class ScheduleSearchResult:
    """Schedules matched for Agent query or disambiguation."""

    schedules: tuple[ScheduleSnapshot, ...]


__all__ = [
    "CreateScheduleCommand",
    "DeleteOnceScheduleCommand",
    "DeleteRecurringScheduleCommand",
    "FindSchedulesQuery",
    "OccurrenceOverrideAction",
    "RecurringDeleteScope",
    "ReminderStrength",
    "ReminderType",
    "ScheduleKind",
    "ScheduleMutationResult",
    "ScheduleOccurrenceOverrideSnapshot",
    "SchedulePatchValue",
    "ScheduleSearchResult",
    "ScheduleSnapshot",
    "ScheduleStatus",
    "ScheduleType",
    "UpdateScheduleCommand",
]
