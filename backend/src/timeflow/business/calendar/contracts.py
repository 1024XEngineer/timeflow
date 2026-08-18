"""Framework-independent contracts for the schedule business boundary."""

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import TypedDict


class ScheduleType(StrEnum):
    """Supported schedule trigger forms."""

    TIME = "time"
    LOCATION = "location"


class ScheduleCategory(StrEnum):
    """Content category assigned independently from the schedule trigger form."""

    WORK = "work"
    STUDY = "study"
    EXERCISE = "exercise"
    ENTERTAINMENT = "entertainment"
    SOCIAL = "social"
    REST = "rest"
    PERSONAL = "personal"
    OTHER = "other"


class ScheduleKind(StrEnum):
    """Whether a schedule occurs once or follows an RRULE."""

    ONCE = "once"
    RECURRING = "recurring"


class ScheduleStatus(StrEnum):
    """Cloud lifecycle status for a schedule."""

    ACTIVE = "active"
    DELETED = "deleted"


class ReminderType(StrEnum):
    """The single reminder configuration attached to a schedule."""

    AT_TIME = "at_time"
    BEFORE_START = "before_start"
    ARRIVE_LOCATION = "arrive_location"
    RETURN_TO_RECORDED_LOCATION = "return_to_recorded_location"


class ReminderStrength(StrEnum):
    """Reminder delivery strength selected for a schedule."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ReminderDispositionState(StrEnum):
    """Cloud-persisted final disposition for the current reminder occurrence."""

    CONFIRMED = "confirmed"


class RecurringDeleteScope(StrEnum):
    """Wiki-defined deletion scopes for a recurring schedule.

    Occurrence-scoped deletion targets the confirmed current occurrence;
    deleting an entire series does not require occurrence resolution.
    """

    THIS_OCCURRENCE = "this_occurrence"
    THIS_AND_FUTURE = "this_and_future"
    ENTIRE_SERIES = "entire_series"


class OccurrenceOverrideAction(StrEnum):
    """Supported changes to one expanded recurring occurrence."""

    CANCEL = "cancel"
    REPLACE = "replace"


class ScheduleErrorCode(StrEnum):
    """Stable business failures raised by the Agent schedule boundary."""

    SCHEDULE_NOT_FOUND = "schedule_not_found"
    REVISION_CONFLICT = "revision_conflict"
    OCCURRENCE_NOT_FOUND = "occurrence_not_found"
    INVALID_TIMEZONE = "invalid_timezone"
    INVALID_UPDATE_PATCH = "invalid_update_patch"
    INVALID_SCHEDULE_KIND = "invalid_schedule_kind"
    VALIDATION_FAILED = "validation_failed"


class ScheduleBusinessError(Exception):
    """Expected schedule failure that callers can translate without parsing text."""

    __slots__ = ("code", "field", "message", "schedule_id")

    def __init__(
        self,
        *,
        code: ScheduleErrorCode,
        message: str,
        schedule_id: str | None = None,
        field: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.schedule_id = schedule_id
        self.field = field


class ScheduleUpdatePatch(TypedDict, total=False):
    """Explicit user-editable fields for an update command.

    Omitting a key leaves the persisted value unchanged. Supplying ``None``
    explicitly clears a nullable field. Identity, ownership, lifecycle,
    revision, and audit fields are intentionally not patchable.
    """

    title: str
    is_all_day: bool
    start_time: datetime | None
    end_time: datetime | None
    timezone: str
    recurrence_rule: str | None
    location_name: str | None
    latitude: float | None
    longitude: float | None
    reminder_type: ReminderType | None
    reminder_trigger_at: datetime | None
    reminder_offset_minutes: int | None
    reminder_strength: ReminderStrength | None


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
    category: ScheduleCategory = ScheduleCategory.OTHER
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
    reminder_disposition_state: ReminderDispositionState | None = None
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
class AccountScheduleSnapshot:
    """All persisted schedules and occurrence overrides for one account."""

    schedules: tuple[ScheduleSnapshot, ...]
    occurrence_overrides: tuple[ScheduleOccurrenceOverrideSnapshot, ...]


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
    changes: ScheduleUpdatePatch


@dataclass(frozen=True, slots=True)
class DeleteOnceScheduleCommand:
    """A confirmed request to soft-delete one non-recurring schedule."""

    schedule_id: str
    expected_revision: int


@dataclass(frozen=True, slots=True)
class DeleteRecurringScheduleCommand:
    """A confirmed request carrying the Wiki-defined recurring deletion scope."""

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
    "AccountScheduleSnapshot",
    "CreateScheduleCommand",
    "DeleteOnceScheduleCommand",
    "DeleteRecurringScheduleCommand",
    "FindSchedulesQuery",
    "OccurrenceOverrideAction",
    "RecurringDeleteScope",
    "ReminderDispositionState",
    "ReminderStrength",
    "ReminderType",
    "ScheduleCategory",
    "ScheduleBusinessError",
    "ScheduleErrorCode",
    "ScheduleKind",
    "ScheduleMutationResult",
    "ScheduleOccurrenceOverrideSnapshot",
    "ScheduleSearchResult",
    "ScheduleSnapshot",
    "ScheduleStatus",
    "ScheduleType",
    "ScheduleUpdatePatch",
    "UpdateScheduleCommand",
]
