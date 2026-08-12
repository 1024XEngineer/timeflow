"""Agent-facing schedule service boundary and application implementation."""

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from typing import NoReturn
from uuid import uuid4
from zoneinfo import ZoneInfo

from timeflow.business.calendar.contracts import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    OccurrenceOverrideAction,
    RecurringDeleteScope,
    ReminderType,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
    ScheduleUpdatePatch,
    UpdateScheduleCommand,
)
from timeflow.business.calendar.ports import (
    ScheduleRepositoryPort,
    ScheduleRevisionConflictError,
    ScheduleUnitOfWorkFactory,
)
from timeflow.business.calendar.recurrence import (
    InvalidRecurrenceRuleError,
    InvalidTimezoneKeyError,
    first_active_occurrence_on_or_after_local_date,
    first_occurrence_in_window,
    get_schedule_timezone,
    normalize_recurrence_rule,
    parse_recurrence_rule,
    truncate_rule_before_occurrence,
)


class ScheduleAgentService(ABC):
    """Five stable schedule operations exposed to the Agent.

    Implementations own persistence, validation, recurrence expansion, and
    mutation logic while callers depend only on this stable boundary.
    """

    @abstractmethod
    def create_schedule(
        self,
        *,
        account_id: str,
        command: CreateScheduleCommand,
    ) -> ScheduleMutationResult:
        """Create an ordinary or recurring schedule from a confirmed command.

        Raises:
            ScheduleBusinessError: If the confirmed command is invalid.
        """
        raise NotImplementedError

    @abstractmethod
    def find_schedules(
        self,
        *,
        account_id: str,
        query: FindSchedulesQuery,
    ) -> ScheduleSearchResult:
        """Find schedules for Agent queries, matching, and disambiguation.

        Raises:
            ScheduleBusinessError: If the query contains invalid criteria.
        """
        raise NotImplementedError

    @abstractmethod
    def update_schedule(
        self,
        *,
        account_id: str,
        command: UpdateScheduleCommand,
    ) -> ScheduleMutationResult:
        """Update one schedule; recurring changes apply to the complete series.

        Raises:
            ScheduleBusinessError: If the target, revision, or patch is invalid.
        """
        raise NotImplementedError

    @abstractmethod
    def delete_once_schedule(
        self,
        *,
        account_id: str,
        command: DeleteOnceScheduleCommand,
    ) -> ScheduleMutationResult:
        """Soft-delete one non-recurring schedule.

        Raises:
            ScheduleBusinessError: If the target or revision is invalid.
        """
        raise NotImplementedError

    @abstractmethod
    def delete_recurring_schedule(
        self,
        *,
        account_id: str,
        command: DeleteRecurringScheduleCommand,
    ) -> ScheduleMutationResult:
        """Apply the confirmed occurrence, future, or entire-series deletion scope.

        Raises:
            ScheduleBusinessError: If the target, revision, or occurrence is invalid.
        """
        raise NotImplementedError


class ScheduleApplicationService(ScheduleAgentService):
    """Transactional implementation of the five stable Agent operations."""

    def __init__(
        self,
        unit_of_work_factory: ScheduleUnitOfWorkFactory,
        *,
        clock: Callable[[], datetime] | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self._unit_of_work_factory = unit_of_work_factory
        self._clock = clock or (lambda: datetime.now(UTC))
        self._id_factory = id_factory or (lambda: uuid4().hex)

    def create_schedule(
        self,
        *,
        account_id: str,
        command: CreateScheduleCommand,
    ) -> ScheduleMutationResult:
        """Validate and persist a new account-owned schedule."""
        _validate_account_id(account_id)
        now = _aware_now(self._clock)
        snapshot = ScheduleSnapshot(
            id=_new_id(self._id_factory, field="id"),
            account_id=account_id,
            schedule_type=command.schedule_type,
            schedule_kind=command.schedule_kind,
            title=command.title,
            is_all_day=command.is_all_day,
            timezone=command.timezone,
            status=ScheduleStatus.ACTIVE,
            revision=1,
            created_at=now,
            updated_at=now,
            start_time=command.start_time,
            end_time=command.end_time,
            recurrence_rule=_normalize_optional_recurrence_rule(command.recurrence_rule),
            location_name=command.location_name,
            latitude=command.latitude,
            longitude=command.longitude,
            reminder_type=command.reminder_type,
            reminder_trigger_at=command.reminder_trigger_at,
            reminder_offset_minutes=command.reminder_offset_minutes,
            reminder_strength=command.reminder_strength,
        )
        _validate_snapshot(snapshot)

        with self._unit_of_work_factory() as unit_of_work:
            persisted = unit_of_work.schedules.add_schedule(snapshot)
            unit_of_work.commit()
        return ScheduleMutationResult(schedules=(persisted,))

    def find_schedules(
        self,
        *,
        account_id: str,
        query: FindSchedulesQuery,
    ) -> ScheduleSearchResult:
        """Return account-scoped schedules matching every supplied criterion."""
        _validate_account_id(account_id)
        _validate_query(query)
        has_time_window = query.starts_at_or_after is not None or query.starts_before is not None

        with self._unit_of_work_factory() as unit_of_work:
            if query.schedule_id is None:
                if has_time_window:
                    candidates = unit_of_work.schedules.list_schedule_candidates(
                        account_id=account_id,
                        starts_at_or_after=query.starts_at_or_after,
                        starts_before=query.starts_before,
                        include_deleted=query.include_deleted,
                    )
                else:
                    candidates = unit_of_work.schedules.list_schedules(
                        account_id=account_id,
                        include_deleted=query.include_deleted,
                    )
            else:
                match = unit_of_work.schedules.get_schedule(
                    account_id=account_id,
                    schedule_id=query.schedule_id,
                    include_deleted=query.include_deleted,
                )
                candidates = () if match is None else (match,)
            candidates = tuple(
                schedule for schedule in candidates if _matches_static_query(schedule, query)
            )
            if not has_time_window:
                return ScheduleSearchResult(schedules=candidates)

            recurring_ids = {
                schedule.id
                for schedule in candidates
                if schedule.schedule_kind is ScheduleKind.RECURRING
            }
            overrides_by_schedule: dict[str, list[ScheduleOccurrenceOverrideSnapshot]] = {
                schedule_id: [] for schedule_id in recurring_ids
            }
            if recurring_ids:
                for override in unit_of_work.schedules.list_occurrence_overrides(
                    account_id=account_id
                ):
                    if override.schedule_id in overrides_by_schedule:
                        overrides_by_schedule[override.schedule_id].append(override)

            matches = tuple(
                schedule
                for schedule in candidates
                if _has_effective_occurrence_in_window(
                    schedule=schedule,
                    query=query,
                    overrides=tuple(overrides_by_schedule.get(schedule.id, ())),
                )
            )
        return ScheduleSearchResult(schedules=matches)

    def update_schedule(
        self,
        *,
        account_id: str,
        command: UpdateScheduleCommand,
    ) -> ScheduleMutationResult:
        """Apply only explicitly supplied mutable fields and increment revision."""
        _validate_account_id(account_id)
        _validate_update_patch(command)
        now = _aware_now(self._clock)

        with self._unit_of_work_factory() as unit_of_work:
            current = _require_active_schedule(
                unit_of_work.schedules,
                account_id=account_id,
                schedule_id=command.schedule_id,
            )
            candidate = replace(current, **command.changes, updated_at=now)
            if "recurrence_rule" in command.changes:
                candidate = replace(
                    candidate,
                    recurrence_rule=_normalize_optional_recurrence_rule(candidate.recurrence_rule),
                )
            _validate_snapshot(candidate)
            persisted = _persist_update(
                unit_of_work.schedules,
                candidate,
                expected_revision=command.expected_revision,
            )
            unit_of_work.commit()
        return ScheduleMutationResult(schedules=(persisted,))

    def delete_once_schedule(
        self,
        *,
        account_id: str,
        command: DeleteOnceScheduleCommand,
    ) -> ScheduleMutationResult:
        """Soft-delete one ordinary schedule and return its final snapshot."""
        _validate_account_id(account_id)
        now = _aware_now(self._clock)
        with self._unit_of_work_factory() as unit_of_work:
            current = _require_active_schedule(
                unit_of_work.schedules,
                account_id=account_id,
                schedule_id=command.schedule_id,
            )
            if current.schedule_kind is not ScheduleKind.ONCE:
                _raise_business_error(
                    ScheduleErrorCode.INVALID_SCHEDULE_KIND,
                    "A recurring schedule must use delete_recurring_schedule.",
                    schedule_id=current.id,
                    field="schedule_id",
                )
            persisted = _soft_delete(
                unit_of_work.schedules,
                current,
                expected_revision=command.expected_revision,
                now=now,
            )
            unit_of_work.commit()
        return ScheduleMutationResult(schedules=(persisted,))

    def delete_recurring_schedule(
        self,
        *,
        account_id: str,
        command: DeleteRecurringScheduleCommand,
    ) -> ScheduleMutationResult:
        """Delete a recurring series according to the Wiki-defined scope."""
        _validate_account_id(account_id)
        now = _aware_now(self._clock)

        with self._unit_of_work_factory() as unit_of_work:
            current = _require_active_schedule(
                unit_of_work.schedules,
                account_id=account_id,
                schedule_id=command.schedule_id,
            )
            if current.schedule_kind is not ScheduleKind.RECURRING:
                _raise_business_error(
                    ScheduleErrorCode.INVALID_SCHEDULE_KIND,
                    "A non-recurring schedule must use delete_once_schedule.",
                    schedule_id=current.id,
                    field="schedule_id",
                )

            if command.scope is RecurringDeleteScope.ENTIRE_SERIES:
                overrides = unit_of_work.schedules.list_occurrence_overrides(
                    account_id=account_id,
                    schedule_id=current.id,
                )
                persisted_parent = _soft_delete(
                    unit_of_work.schedules,
                    current,
                    expected_revision=command.expected_revision,
                    now=now,
                )
                deleted_replacements = _soft_delete_replacements(
                    unit_of_work.schedules,
                    account_id=account_id,
                    overrides=overrides,
                    now=now,
                )
                result = ScheduleMutationResult(schedules=(persisted_parent, *deleted_replacements))
            else:
                result = self._delete_recurring_range(
                    unit_of_work.schedules,
                    account_id=account_id,
                    current=current,
                    command=command,
                    now=now,
                )
            unit_of_work.commit()
        return result

    def _delete_recurring_range(
        self,
        repository: ScheduleRepositoryPort,
        *,
        account_id: str,
        current: ScheduleSnapshot,
        command: DeleteRecurringScheduleCommand,
        now: datetime,
    ) -> ScheduleMutationResult:
        _validated_timezone(current.timezone)
        overrides = repository.list_occurrence_overrides(
            account_id=account_id,
            schedule_id=current.id,
        )
        try:
            occurrence = first_active_occurrence_on_or_after_local_date(
                current,
                now=now,
                overrides=overrides,
            )
        except InvalidRecurrenceRuleError:
            _raise_business_error(
                ScheduleErrorCode.VALIDATION_FAILED,
                "The persisted recurrence_rule cannot be expanded.",
                schedule_id=current.id,
                field="recurrence_rule",
            )
        if occurrence is None:
            _raise_business_error(
                ScheduleErrorCode.OCCURRENCE_NOT_FOUND,
                "No recurring occurrence exists on or after the current local date.",
                schedule_id=current.id,
                field="scope",
            )

        if command.scope is RecurringDeleteScope.THIS_OCCURRENCE:
            updated_schedule = _persist_update(
                repository,
                replace(current, updated_at=now),
                expected_revision=command.expected_revision,
            )
            matching_replacements = tuple(
                override
                for override in overrides
                if override.occurrence_start == occurrence
                and override.action is OccurrenceOverrideAction.REPLACE
            )
            if matching_replacements:
                deleted_replacements = _soft_delete_replacements(
                    repository,
                    account_id=account_id,
                    overrides=matching_replacements,
                    now=now,
                )
                return ScheduleMutationResult(schedules=(updated_schedule, *deleted_replacements))
            override = ScheduleOccurrenceOverrideSnapshot(
                id=_new_id(self._id_factory, field="occurrence_override_id"),
                schedule_id=current.id,
                occurrence_start=occurrence,
                action=OccurrenceOverrideAction.CANCEL,
                created_at=now,
                updated_at=now,
            )
            persisted_override = repository.add_occurrence_override(
                account_id=account_id,
                snapshot=override,
            )
            if persisted_override is None:
                _raise_not_found(current.id)
            return ScheduleMutationResult(
                schedules=(updated_schedule,),
                occurrence_overrides=(persisted_override,),
            )

        try:
            truncated_rule = truncate_rule_before_occurrence(current, occurrence)
        except InvalidRecurrenceRuleError:
            _raise_business_error(
                ScheduleErrorCode.VALIDATION_FAILED,
                "The persisted recurrence_rule cannot be truncated.",
                schedule_id=current.id,
                field="recurrence_rule",
            )
        if truncated_rule is None:
            persisted = _soft_delete(
                repository,
                current,
                expected_revision=command.expected_revision,
                now=now,
            )
        else:
            candidate = replace(current, recurrence_rule=truncated_rule, updated_at=now)
            _validate_snapshot(candidate)
            persisted = _persist_update(
                repository,
                candidate,
                expected_revision=command.expected_revision,
            )
        deleted_replacements = _soft_delete_replacements(
            repository,
            account_id=account_id,
            overrides=overrides,
            now=now,
            occurrence_start_at_or_after=occurrence,
        )
        return ScheduleMutationResult(schedules=(persisted, *deleted_replacements))


def _matches_static_query(schedule: ScheduleSnapshot, query: FindSchedulesQuery) -> bool:
    title = None if query.title is None else query.title.casefold()
    location = None if query.location_name is None else query.location_name.casefold()
    return (title is None or title in schedule.title.casefold()) and (
        location is None
        or (schedule.location_name is not None and location in schedule.location_name.casefold())
    )


def _has_effective_occurrence_in_window(
    *,
    schedule: ScheduleSnapshot,
    query: FindSchedulesQuery,
    overrides: tuple[ScheduleOccurrenceOverrideSnapshot, ...],
) -> bool:
    if schedule.schedule_kind is ScheduleKind.ONCE:
        return _start_is_in_window(schedule.start_time, query)

    excluded_starts = frozenset(override.occurrence_start for override in overrides)
    try:
        occurrence = first_occurrence_in_window(
            schedule,
            starts_at_or_after=query.starts_at_or_after,
            starts_before=query.starts_before,
            excluded_occurrence_starts=excluded_starts,
        )
    except InvalidTimezoneKeyError:
        _invalid_timezone(schedule.timezone)
    except InvalidRecurrenceRuleError:
        _raise_business_error(
            ScheduleErrorCode.VALIDATION_FAILED,
            "The persisted recurrence_rule cannot be expanded.",
            schedule_id=schedule.id,
            field="recurrence_rule",
        )
    return occurrence is not None


def _start_is_in_window(start_time: datetime | None, query: FindSchedulesQuery) -> bool:
    if start_time is None:
        return False
    return (query.starts_at_or_after is None or start_time >= query.starts_at_or_after) and (
        query.starts_before is None or start_time < query.starts_before
    )


def _persist_update(
    repository: ScheduleRepositoryPort,
    snapshot: ScheduleSnapshot,
    *,
    expected_revision: int,
) -> ScheduleSnapshot:
    try:
        persisted = repository.update_schedule(
            snapshot=snapshot,
            expected_revision=expected_revision,
        )
    except ScheduleRevisionConflictError as exc:
        _raise_business_error(
            ScheduleErrorCode.REVISION_CONFLICT,
            "The schedule changed after it was read; query it again before retrying.",
            schedule_id=exc.schedule_id,
            field="expected_revision",
        )
    if persisted is None:
        _raise_not_found(snapshot.id)
    return persisted


def _soft_delete(
    repository: ScheduleRepositoryPort,
    current: ScheduleSnapshot,
    *,
    expected_revision: int,
    now: datetime,
) -> ScheduleSnapshot:
    candidate = replace(
        current,
        status=ScheduleStatus.DELETED,
        updated_at=now,
        deleted_at=now,
    )
    return _persist_update(repository, candidate, expected_revision=expected_revision)


def _soft_delete_replacements(
    repository: ScheduleRepositoryPort,
    *,
    account_id: str,
    overrides: tuple[ScheduleOccurrenceOverrideSnapshot, ...],
    now: datetime,
    occurrence_start_at_or_after: datetime | None = None,
) -> tuple[ScheduleSnapshot, ...]:
    """Soft-delete active replacement schedules selected by original occurrence.

    Each replacement uses its own current revision through the ordinary
    Repository update path. The caller owns the surrounding unit of work, so a
    conflict on any replacement rolls back the parent and every earlier write.
    """
    deleted: list[ScheduleSnapshot] = []
    handled_schedule_ids: set[str] = set()
    for override in overrides:
        replacement_id = override.replacement_schedule_id
        if (
            override.action is not OccurrenceOverrideAction.REPLACE
            or replacement_id is None
            or replacement_id in handled_schedule_ids
            or (
                occurrence_start_at_or_after is not None
                and override.occurrence_start < occurrence_start_at_or_after
            )
        ):
            continue
        handled_schedule_ids.add(replacement_id)
        replacement = repository.get_schedule(
            account_id=account_id,
            schedule_id=replacement_id,
        )
        if replacement is None:
            continue
        deleted.append(
            _soft_delete(
                repository,
                replacement,
                expected_revision=replacement.revision,
                now=now,
            )
        )
    return tuple(deleted)


def _require_active_schedule(
    repository: ScheduleRepositoryPort,
    *,
    account_id: str,
    schedule_id: str,
) -> ScheduleSnapshot:
    if not schedule_id.strip():
        _raise_business_error(
            ScheduleErrorCode.VALIDATION_FAILED,
            "schedule_id must be non-empty.",
            field="schedule_id",
        )
    schedule = repository.get_schedule(account_id=account_id, schedule_id=schedule_id)
    if schedule is None:
        _raise_not_found(schedule_id)
    return schedule


def _validate_account_id(account_id: str) -> None:
    if not account_id.strip():
        _raise_business_error(
            ScheduleErrorCode.VALIDATION_FAILED,
            "account_id must be non-empty.",
            field="account_id",
        )


def _validate_query(query: FindSchedulesQuery) -> None:
    for field, value in (("schedule_id", query.schedule_id), ("title", query.title)):
        if value is not None and not value.strip():
            _raise_business_error(
                ScheduleErrorCode.VALIDATION_FAILED,
                f"{field} must be non-empty when supplied.",
                field=field,
            )
    if query.location_name is not None and not query.location_name.strip():
        _raise_business_error(
            ScheduleErrorCode.VALIDATION_FAILED,
            "location_name must be non-empty when supplied.",
            field="location_name",
        )
    _validate_optional_datetime(query.starts_at_or_after, "starts_at_or_after")
    _validate_optional_datetime(query.starts_before, "starts_before")
    if (
        query.starts_at_or_after is not None
        and query.starts_before is not None
        and query.starts_at_or_after >= query.starts_before
    ):
        _raise_business_error(
            ScheduleErrorCode.VALIDATION_FAILED,
            "starts_at_or_after must be earlier than starts_before.",
            field="starts_before",
        )


def _validate_update_patch(command: UpdateScheduleCommand) -> None:
    if not command.changes:
        _raise_business_error(
            ScheduleErrorCode.INVALID_UPDATE_PATCH,
            "changes must contain at least one editable field.",
            schedule_id=command.schedule_id,
            field="changes",
        )
    allowed = ScheduleUpdatePatch.__optional_keys__
    unknown = set(command.changes).difference(allowed)
    if unknown:
        _raise_business_error(
            ScheduleErrorCode.INVALID_UPDATE_PATCH,
            f"changes contains protected or unknown fields: {', '.join(sorted(unknown))}.",
            schedule_id=command.schedule_id,
            field="changes",
        )


def _validate_snapshot(snapshot: ScheduleSnapshot) -> None:
    if not snapshot.title.strip() or len(snapshot.title) > 255:
        _validation_error("title must contain 1 to 255 characters", field="title")
    if not snapshot.timezone.strip() or len(snapshot.timezone) > 64:
        _invalid_timezone(snapshot.timezone)
    timezone = _validated_timezone(snapshot.timezone)

    for field, value in (
        ("created_at", snapshot.created_at),
        ("updated_at", snapshot.updated_at),
        ("start_time", snapshot.start_time),
        ("end_time", snapshot.end_time),
        ("reminder_trigger_at", snapshot.reminder_trigger_at),
        ("deleted_at", snapshot.deleted_at),
    ):
        _validate_optional_datetime(value, field)

    if snapshot.revision < 1:
        _validation_error("revision must be positive", field="revision")
    if snapshot.location_name is not None and len(snapshot.location_name) > 255:
        _validation_error("location_name must not exceed 255 characters", field="location_name")
    if (snapshot.latitude is None) != (snapshot.longitude is None):
        _validation_error("latitude and longitude must be supplied together", field="latitude")
    if snapshot.latitude is not None and not -90 <= snapshot.latitude <= 90:
        _validation_error("latitude must be between -90 and 90", field="latitude")
    if snapshot.longitude is not None and not -180 <= snapshot.longitude <= 180:
        _validation_error("longitude must be between -180 and 180", field="longitude")

    if snapshot.schedule_type is ScheduleType.TIME:
        if snapshot.start_time is None:
            _validation_error("time schedules require start_time", field="start_time")
    elif snapshot.schedule_type is ScheduleType.LOCATION:
        if snapshot.is_all_day:
            _validation_error("location schedules cannot be all-day", field="is_all_day")
        if snapshot.latitude is None:
            _validation_error("location schedules require coordinates", field="latitude")

    if snapshot.end_time is not None:
        if snapshot.start_time is None or snapshot.end_time <= snapshot.start_time:
            _validation_error("end_time must be later than start_time", field="end_time")
    if snapshot.is_all_day:
        if (
            snapshot.schedule_type is not ScheduleType.TIME
            or snapshot.start_time is None
            or snapshot.end_time is None
        ):
            _validation_error(
                "all-day schedules require time-schedule date boundaries",
                field="end_time",
            )
        local_start = snapshot.start_time.astimezone(timezone)
        local_end = snapshot.end_time.astimezone(timezone)
        if not _is_local_midnight(local_start):
            _validation_error(
                "all-day start_time must be local midnight",
                field="start_time",
            )
        if not _is_local_midnight(local_end):
            _validation_error(
                "all-day end_time must be local midnight",
                field="end_time",
            )
        if local_end.date() <= local_start.date():
            _validation_error(
                "all-day end date must be later than its start date",
                field="end_time",
            )

    if snapshot.schedule_kind is ScheduleKind.ONCE:
        if snapshot.recurrence_rule is not None:
            _validation_error(
                "one-time schedules cannot have recurrence_rule", field="recurrence_rule"
            )
    else:
        if snapshot.schedule_type is not ScheduleType.TIME:
            _validation_error("recurring schedules must be time schedules", field="schedule_type")
        if snapshot.recurrence_rule is None or snapshot.start_time is None:
            _validation_error(
                "recurring schedules require recurrence_rule", field="recurrence_rule"
            )
        if len(snapshot.recurrence_rule) > 512:
            _validation_error(
                "recurrence_rule must not exceed 512 characters", field="recurrence_rule"
            )
        try:
            parse_recurrence_rule(
                snapshot.recurrence_rule,
                start_time=snapshot.start_time.astimezone(timezone),
            )
        except InvalidRecurrenceRuleError:
            _validation_error(
                "recurrence_rule is not a valid RFC 5545 RRULE",
                field="recurrence_rule",
            )

    _validate_reminder(snapshot)
    if snapshot.status is ScheduleStatus.ACTIVE and snapshot.deleted_at is not None:
        _validation_error("active schedules cannot have deleted_at", field="deleted_at")
    if snapshot.status is ScheduleStatus.DELETED and snapshot.deleted_at is None:
        _validation_error("deleted schedules require deleted_at", field="deleted_at")


def _validate_reminder(snapshot: ScheduleSnapshot) -> None:
    if snapshot.reminder_type is None:
        if any(
            value is not None
            for value in (
                snapshot.reminder_trigger_at,
                snapshot.reminder_offset_minutes,
                snapshot.reminder_strength,
                snapshot.reminder_disposition_state,
            )
        ):
            _validation_error(
                "reminder fields must be empty when reminder_type is empty",
                field="reminder_type",
            )
        return
    if snapshot.reminder_strength is None:
        _validation_error("reminder_strength is required", field="reminder_strength")
    if snapshot.reminder_offset_minutes is not None and snapshot.reminder_offset_minutes < 0:
        _validation_error(
            "reminder_offset_minutes cannot be negative",
            field="reminder_offset_minutes",
        )
    if snapshot.reminder_type is ReminderType.AT_TIME:
        if (
            snapshot.schedule_type is not ScheduleType.TIME
            or snapshot.start_time is None
            or snapshot.reminder_trigger_at is None
            or snapshot.reminder_offset_minutes is not None
        ):
            _validation_error(
                "at_time requires a time schedule and reminder_trigger_at only",
                field="reminder_type",
            )
    elif snapshot.reminder_type is ReminderType.BEFORE_START:
        if (
            snapshot.schedule_type is not ScheduleType.TIME
            or snapshot.start_time is None
            or snapshot.reminder_trigger_at is not None
            or snapshot.reminder_offset_minutes is None
        ):
            _validation_error(
                "before_start requires reminder_offset_minutes on a time schedule",
                field="reminder_type",
            )
    elif (
        snapshot.latitude is None
        or snapshot.reminder_trigger_at is not None
        or snapshot.reminder_offset_minutes is not None
    ):
        _validation_error(
            "location reminders require coordinates and no time trigger fields",
            field="reminder_type",
        )


def _validate_optional_datetime(value: datetime | None, field: str) -> None:
    if value is not None and (value.tzinfo is None or value.utcoffset() is None):
        _validation_error(f"{field} must include a UTC offset", field=field)


def _is_local_midnight(value: datetime) -> bool:
    return (value.hour, value.minute, value.second, value.microsecond) == (0, 0, 0, 0)


def _aware_now(clock: Callable[[], datetime]) -> datetime:
    now = clock()
    if now.tzinfo is None or now.utcoffset() is None:
        _validation_error("the application clock must return an aware datetime", field="clock")
    return now


def _new_id(id_factory: Callable[[], str], *, field: str) -> str:
    value = id_factory()
    if not value or len(value) > 64:
        _validation_error(f"{field} must contain 1 to 64 characters", field=field)
    return value


def _normalize_optional_recurrence_rule(rule: str | None) -> str | None:
    if rule is None:
        return None
    try:
        return normalize_recurrence_rule(rule)
    except InvalidRecurrenceRuleError:
        _validation_error(
            "recurrence_rule must contain exactly one RFC 5545 RRULE",
            field="recurrence_rule",
        )


def _validated_timezone(timezone: str) -> ZoneInfo:
    try:
        return get_schedule_timezone(timezone)
    except InvalidTimezoneKeyError:
        _invalid_timezone(timezone)


def _invalid_timezone(timezone: str) -> NoReturn:
    _raise_business_error(
        ScheduleErrorCode.INVALID_TIMEZONE,
        f"{timezone!r} is not a valid IANA timezone.",
        field="timezone",
    )


def _validation_error(message: str, *, field: str) -> NoReturn:
    _raise_business_error(ScheduleErrorCode.VALIDATION_FAILED, message, field=field)


def _raise_not_found(schedule_id: str) -> NoReturn:
    _raise_business_error(
        ScheduleErrorCode.SCHEDULE_NOT_FOUND,
        "The schedule does not exist for this account.",
        schedule_id=schedule_id,
        field="schedule_id",
    )


def _raise_business_error(
    code: ScheduleErrorCode,
    message: str,
    *,
    schedule_id: str | None = None,
    field: str | None = None,
) -> NoReturn:
    raise ScheduleBusinessError(
        code=code,
        message=message,
        schedule_id=schedule_id,
        field=field,
    )


__all__ = ["ScheduleAgentService", "ScheduleApplicationService"]
