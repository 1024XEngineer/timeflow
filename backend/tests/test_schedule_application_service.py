"""Business tests for the five stable Agent schedule operations."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from itertools import count
from types import TracebackType

import pytest

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    OccurrenceOverrideAction,
    RecurringDeleteScope,
    ReminderStrength,
    ReminderType,
    ScheduleApplicationService,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
    UpdateScheduleCommand,
)
from timeflow.business.calendar.ports import ScheduleRevisionConflictError

NOW = datetime(2026, 8, 11, 1, tzinfo=UTC)


@dataclass
class _Store:
    schedules: dict[str, ScheduleSnapshot]
    overrides: dict[str, ScheduleOccurrenceOverrideSnapshot]


class _Repository:
    def __init__(self, store: _Store) -> None:
        self._store = store

    def add_schedule(self, snapshot: ScheduleSnapshot) -> ScheduleSnapshot:
        if snapshot.id in self._store.schedules:
            raise RuntimeError("duplicate test id")
        self._store.schedules[snapshot.id] = snapshot
        return snapshot

    def get_schedule(
        self,
        *,
        account_id: str,
        schedule_id: str,
        include_deleted: bool = False,
    ) -> ScheduleSnapshot | None:
        snapshot = self._store.schedules.get(schedule_id)
        if snapshot is None or snapshot.account_id != account_id:
            return None
        if not include_deleted and snapshot.status is ScheduleStatus.DELETED:
            return None
        return snapshot

    def list_schedules(
        self,
        *,
        account_id: str,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]:
        return tuple(
            snapshot
            for snapshot in sorted(
                self._store.schedules.values(),
                key=lambda item: (item.start_time or item.created_at, item.id),
            )
            if snapshot.account_id == account_id
            and (include_deleted or snapshot.status is ScheduleStatus.ACTIVE)
        )

    def list_schedule_candidates(
        self,
        *,
        account_id: str,
        starts_at_or_after: datetime | None,
        starts_before: datetime | None,
        include_deleted: bool = False,
    ) -> tuple[ScheduleSnapshot, ...]:
        schedules = self.list_schedules(
            account_id=account_id,
            include_deleted=include_deleted,
        )
        return tuple(
            schedule
            for schedule in schedules
            if (
                schedule.schedule_kind is ScheduleKind.RECURRING
                and schedule.start_time is not None
                and (starts_before is None or schedule.start_time < starts_before)
            )
            or (
                schedule.schedule_kind is ScheduleKind.ONCE
                and schedule.start_time is not None
                and (starts_at_or_after is None or schedule.start_time >= starts_at_or_after)
                and (starts_before is None or schedule.start_time < starts_before)
            )
        )

    def update_schedule(
        self,
        *,
        snapshot: ScheduleSnapshot,
        expected_revision: int,
    ) -> ScheduleSnapshot | None:
        current = self._store.schedules.get(snapshot.id)
        if current is None or current.account_id != snapshot.account_id:
            return None
        if current.revision != expected_revision:
            raise ScheduleRevisionConflictError(
                schedule_id=current.id,
                expected_revision=expected_revision,
                actual_revision=current.revision,
            )
        persisted = replace(
            snapshot,
            revision=current.revision + 1,
            created_at=current.created_at,
        )
        self._store.schedules[persisted.id] = persisted
        return persisted

    def add_occurrence_override(
        self,
        *,
        account_id: str,
        snapshot: ScheduleOccurrenceOverrideSnapshot,
    ) -> ScheduleOccurrenceOverrideSnapshot | None:
        parent = self._store.schedules.get(snapshot.schedule_id)
        if parent is None or parent.account_id != account_id:
            return None
        duplicate = any(
            item.schedule_id == snapshot.schedule_id
            and item.occurrence_start == snapshot.occurrence_start
            for item in self._store.overrides.values()
        )
        if duplicate:
            raise RuntimeError("duplicate test occurrence")
        self._store.overrides[snapshot.id] = snapshot
        return snapshot

    def update_occurrence_override(
        self,
        *,
        account_id: str,
        schedule_id: str,
        occurrence_start: datetime,
        action: OccurrenceOverrideAction,
        replacement_schedule_id: str | None,
        updated_at: datetime,
    ) -> ScheduleOccurrenceOverrideSnapshot | None:
        for override_id, current in self._store.overrides.items():
            parent = self._store.schedules.get(current.schedule_id)
            if (
                current.schedule_id == schedule_id
                and current.occurrence_start == occurrence_start
                and parent is not None
                and parent.account_id == account_id
            ):
                updated = replace(
                    current,
                    action=action,
                    replacement_schedule_id=replacement_schedule_id,
                    updated_at=updated_at,
                )
                self._store.overrides[override_id] = updated
                return updated
        return None

    def list_occurrence_overrides(
        self,
        *,
        account_id: str,
        schedule_id: str | None = None,
    ) -> tuple[ScheduleOccurrenceOverrideSnapshot, ...]:
        return tuple(
            override
            for override in sorted(
                self._store.overrides.values(),
                key=lambda item: (item.occurrence_start, item.id),
            )
            if (schedule_id is None or override.schedule_id == schedule_id)
            and self._store.schedules[override.schedule_id].account_id == account_id
        )


class _UnitOfWork:
    def __init__(self, committed: _Store) -> None:
        self._committed = committed
        self._working = _Store(
            schedules=dict(committed.schedules),
            overrides=dict(committed.overrides),
        )
        self.schedules = _Repository(self._working)

    def __enter__(self) -> _UnitOfWork:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    def commit(self) -> None:
        self._committed.schedules = dict(self._working.schedules)
        self._committed.overrides = dict(self._working.overrides)


def _service(
    *,
    now: datetime = NOW,
) -> tuple[ScheduleApplicationService, _Store]:
    store = _Store({}, {})
    sequence = count(1)
    service = ScheduleApplicationService(
        lambda: _UnitOfWork(store),
        clock=lambda: now,
        id_factory=lambda: f"generated-{next(sequence)}",
    )
    return service, store


def _time_command(
    *,
    title: str = "项目同步",
    start_time: datetime = datetime(2026, 8, 12, 7, tzinfo=UTC),
    schedule_kind: ScheduleKind = ScheduleKind.ONCE,
    recurrence_rule: str | None = None,
) -> CreateScheduleCommand:
    return CreateScheduleCommand(
        schedule_type=ScheduleType.TIME,
        schedule_kind=schedule_kind,
        title=title,
        timezone="Asia/Shanghai",
        start_time=start_time,
        recurrence_rule=recurrence_rule,
    )


def _all_day_command(
    *,
    timezone: str,
    start_time: datetime,
    end_time: datetime,
) -> CreateScheduleCommand:
    return CreateScheduleCommand(
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title="All-day event",
        timezone=timezone,
        is_all_day=True,
        start_time=start_time,
        end_time=end_time,
    )


def _assert_error(
    expected: ScheduleErrorCode,
    operation: Callable[[], object],
) -> ScheduleBusinessError:
    with pytest.raises(ScheduleBusinessError) as raised:
        operation()
    assert raised.value.code is expected
    return raised.value


def _add_override(
    store: _Store,
    *,
    override_id: str,
    schedule_id: str,
    occurrence_start: datetime,
    action: OccurrenceOverrideAction,
    replacement_schedule_id: str | None = None,
) -> None:
    store.overrides[override_id] = ScheduleOccurrenceOverrideSnapshot(
        id=override_id,
        schedule_id=schedule_id,
        occurrence_start=occurrence_start,
        action=action,
        replacement_schedule_id=replacement_schedule_id,
        created_at=NOW,
        updated_at=NOW,
    )


def _add_replacement(
    service: ScheduleApplicationService,
    store: _Store,
    *,
    parent_id: str,
    override_id: str,
    occurrence_start: datetime,
    replacement_start: datetime,
    account_id: str = "account-a",
) -> ScheduleSnapshot:
    replacement = service.create_schedule(
        account_id=account_id,
        command=_time_command(
            title=f"Replacement {override_id}",
            start_time=replacement_start,
        ),
    ).schedules[0]
    _add_override(
        store,
        override_id=override_id,
        schedule_id=parent_id,
        occurrence_start=occurrence_start,
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id=replacement.id,
    )
    return replacement


def test_create_schedule_returns_the_committed_cloud_snapshot() -> None:
    service, store = _service()

    result = service.create_schedule(account_id="account-a", command=_time_command())

    snapshot = result.schedules[0]
    assert snapshot.id == "generated-1"
    assert snapshot.account_id == "account-a"
    assert snapshot.status is ScheduleStatus.ACTIVE
    assert snapshot.revision == 1
    assert snapshot.created_at == NOW
    assert snapshot.updated_at == NOW
    assert store.schedules[snapshot.id] == snapshot


@pytest.mark.parametrize(
    ("command", "code", "field"),
    [
        (
            replace(_time_command(), timezone="Not/A-Timezone"),
            ScheduleErrorCode.INVALID_TIMEZONE,
            "timezone",
        ),
        (
            replace(_time_command(), timezone="../America/New_York"),
            ScheduleErrorCode.INVALID_TIMEZONE,
            "timezone",
        ),
        (
            replace(_time_command(), start_time=None),
            ScheduleErrorCode.VALIDATION_FAILED,
            "start_time",
        ),
        (
            CreateScheduleCommand(
                schedule_type=ScheduleType.LOCATION,
                schedule_kind=ScheduleKind.ONCE,
                title="回到停车位置",
                timezone="Asia/Shanghai",
            ),
            ScheduleErrorCode.VALIDATION_FAILED,
            "latitude",
        ),
        (
            _time_command(
                schedule_kind=ScheduleKind.RECURRING,
                recurrence_rule="not-an-rrule",
            ),
            ScheduleErrorCode.VALIDATION_FAILED,
            "recurrence_rule",
        ),
        (
            replace(
                _time_command(),
                reminder_type=ReminderType.BEFORE_START,
                reminder_offset_minutes=15,
            ),
            ScheduleErrorCode.VALIDATION_FAILED,
            "reminder_strength",
        ),
    ],
)
def test_create_schedule_rejects_invalid_aggregates(
    command: CreateScheduleCommand,
    code: ScheduleErrorCode,
    field: str,
) -> None:
    service, store = _service()

    error = _assert_error(
        code,
        lambda: service.create_schedule(account_id="account-a", command=command),
    )

    assert error.field == field
    assert store.schedules == {}


def test_create_schedule_accepts_location_recurring_and_reminder_shapes() -> None:
    service, _ = _service()
    location = CreateScheduleCommand(
        schedule_type=ScheduleType.LOCATION,
        schedule_kind=ScheduleKind.ONCE,
        title="到公司",
        timezone="Asia/Shanghai",
        location_name="办公室",
        latitude=31.2304,
        longitude=121.4737,
        reminder_type=ReminderType.ARRIVE_LOCATION,
        reminder_strength=ReminderStrength.MEDIUM,
    )
    recurring = replace(
        _time_command(),
        schedule_kind=ScheduleKind.RECURRING,
        recurrence_rule="FREQ=WEEKLY;BYDAY=WE",
        reminder_type=ReminderType.BEFORE_START,
        reminder_offset_minutes=15,
        reminder_strength=ReminderStrength.HIGH,
    )

    location_result = service.create_schedule(account_id="account-a", command=location)
    recurring_result = service.create_schedule(account_id="account-a", command=recurring)

    assert location_result.schedules[0].schedule_type is ScheduleType.LOCATION
    assert recurring_result.schedules[0].schedule_kind is ScheduleKind.RECURRING


@pytest.mark.parametrize(
    "command",
    [
        _all_day_command(
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 16, 16, tzinfo=UTC),
            end_time=datetime(2026, 8, 17, 16, tzinfo=UTC),
        ),
        _all_day_command(
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 16, 16, tzinfo=UTC),
            end_time=datetime(2026, 8, 20, 16, tzinfo=UTC),
        ),
        _all_day_command(
            timezone="America/New_York",
            start_time=datetime(2026, 3, 8, 5, tzinfo=UTC),
            end_time=datetime(2026, 3, 9, 4, tzinfo=UTC),
        ),
    ],
)
def test_create_schedule_accepts_local_all_day_boundaries(
    command: CreateScheduleCommand,
) -> None:
    service, _ = _service()

    result = service.create_schedule(account_id="account-a", command=command)

    assert result.schedules[0].is_all_day is True


@pytest.mark.parametrize(
    "command",
    [
        _all_day_command(
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 17, 2, tzinfo=UTC),
            end_time=datetime(2026, 8, 17, 16, tzinfo=UTC),
        ),
        _all_day_command(
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 16, 16, tzinfo=UTC),
            end_time=datetime(2026, 8, 17, 3, tzinfo=UTC),
        ),
        _all_day_command(
            timezone="Asia/Shanghai",
            start_time=datetime(2026, 8, 16, 16, tzinfo=UTC),
            end_time=datetime(2026, 8, 16, 16, tzinfo=UTC),
        ),
        CreateScheduleCommand(
            schedule_type=ScheduleType.LOCATION,
            schedule_kind=ScheduleKind.ONCE,
            title="Invalid all-day location",
            timezone="Asia/Shanghai",
            is_all_day=True,
            start_time=datetime(2026, 8, 16, 16, tzinfo=UTC),
            end_time=datetime(2026, 8, 17, 16, tzinfo=UTC),
            latitude=31.2304,
            longitude=121.4737,
        ),
    ],
)
def test_create_schedule_rejects_non_boundary_all_day_values(
    command: CreateScheduleCommand,
) -> None:
    service, store = _service()

    _assert_error(
        ScheduleErrorCode.VALIDATION_FAILED,
        lambda: service.create_schedule(account_id="account-a", command=command),
    )

    assert store.schedules == {}


@pytest.mark.parametrize("timezone", ["UTC", "Asia/Shanghai", "America/New_York"])
def test_create_schedule_accepts_valid_iana_timezones(timezone: str) -> None:
    service, _ = _service()

    result = service.create_schedule(
        account_id="account-a",
        command=replace(_time_command(), timezone=timezone),
    )

    assert result.schedules[0].timezone == timezone


@pytest.mark.parametrize(
    "rule",
    [
        "RDATE:20260810T090000Z",
        "EXRULE:FREQ=WEEKLY",
        "DTSTART:20260810T090000Z",
        "RRULE:FREQ=DAILY\nRDATE:20260810T090000Z",
        "",
        "FREQ=NOT_A_FREQUENCY",
    ],
)
def test_create_schedule_translates_non_single_rrules_to_business_errors(rule: str) -> None:
    service, store = _service()
    command = _time_command(
        schedule_kind=ScheduleKind.RECURRING,
        recurrence_rule=rule,
    )

    error = _assert_error(
        ScheduleErrorCode.VALIDATION_FAILED,
        lambda: service.create_schedule(account_id="account-a", command=command),
    )

    assert error.field == "recurrence_rule"
    assert store.schedules == {}


def test_create_schedule_normalizes_one_rrule_prefix_before_persistence() -> None:
    service, _ = _service()

    result = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="RRULE:FREQ=WEEKLY;BYDAY=WE",
        ),
    )

    assert result.schedules[0].recurrence_rule == "FREQ=WEEKLY;BYDAY=WE"


def test_find_schedules_filters_without_leaking_other_accounts_or_deleted_rows() -> None:
    service, _ = _service()
    first = service.create_schedule(
        account_id="account-a",
        command=_time_command(title="项目同步", start_time=datetime(2026, 8, 12, 7, tzinfo=UTC)),
    ).schedules[0]
    second = service.create_schedule(
        account_id="account-a",
        command=replace(
            _time_command(
                title="项目复盘",
                start_time=datetime(2026, 8, 14, 7, tzinfo=UTC),
            ),
            location_name="203 会议室",
        ),
    ).schedules[0]
    service.create_schedule(account_id="account-b", command=_time_command(title="项目秘密"))
    service.delete_once_schedule(
        account_id="account-a",
        command=DeleteOnceScheduleCommand(first.id, first.revision),
    )

    matches = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            title="项目",
            location_name="203",
            starts_at_or_after=datetime(2026, 8, 13, tzinfo=UTC),
            starts_before=datetime(2026, 8, 15, tzinfo=UTC),
        ),
    )
    with_deleted = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(schedule_id=first.id, include_deleted=True),
    )

    assert matches.schedules == (second,)
    assert with_deleted.schedules[0].status is ScheduleStatus.DELETED


def test_find_schedules_filters_one_time_occurrences_by_half_open_window() -> None:
    service, _ = _service()
    inside = service.create_schedule(
        account_id="account-a",
        command=_time_command(start_time=datetime(2026, 8, 17, 1, tzinfo=UTC)),
    ).schedules[0]
    service.create_schedule(
        account_id="account-a",
        command=_time_command(start_time=datetime(2026, 8, 18, 1, tzinfo=UTC)),
    )
    query = FindSchedulesQuery(
        starts_at_or_after=datetime(2026, 8, 16, 16, tzinfo=UTC),
        starts_before=datetime(2026, 8, 17, 16, tzinfo=UTC),
    )

    result = service.find_schedules(account_id="account-a", query=query)

    assert result.schedules == (inside,)


def test_find_schedules_expands_recurring_occurrences_only_in_query_window() -> None:
    service, _ = _service()
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 1, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]

    august_17 = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 16, 16, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 16, tzinfo=UTC),
        ),
    )
    august_18 = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 17, 16, tzinfo=UTC),
            starts_before=datetime(2026, 8, 18, 16, tzinfo=UTC),
        ),
    )

    assert august_17.schedules == (recurring,)
    assert august_18.schedules == ()


def test_find_schedules_excludes_a_cancelled_recurring_occurrence() -> None:
    service, store = _service()
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 1, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    _add_override(
        store,
        override_id="cancel-august-17",
        schedule_id=recurring.id,
        occurrence_start=datetime(2026, 8, 17, 1, tzinfo=UTC),
        action=OccurrenceOverrideAction.CANCEL,
    )

    result = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 16, 16, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 16, tzinfo=UTC),
        ),
    )

    assert result.schedules == ()


def test_find_schedules_uses_same_day_replacement_effective_time() -> None:
    service, store = _service()
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 1, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    replacement = service.create_schedule(
        account_id="account-a",
        command=_time_command(start_time=datetime(2026, 8, 17, 6, tzinfo=UTC)),
    ).schedules[0]
    _add_override(
        store,
        override_id="replace-august-17",
        schedule_id=recurring.id,
        occurrence_start=datetime(2026, 8, 17, 1, tzinfo=UTC),
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id=replacement.id,
    )

    effective_window = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 17, 5, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 7, tzinfo=UTC),
        ),
    )
    original_window = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 17, 0, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 2, tzinfo=UTC),
        ),
    )

    assert effective_window.schedules == (replacement,)
    assert original_window.schedules == ()


def test_find_schedules_includes_replacement_that_crosses_into_window() -> None:
    service, store = _service()
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 2, 1, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=SU",
        ),
    ).schedules[0]
    replacement = service.create_schedule(
        account_id="account-a",
        command=_time_command(start_time=datetime(2026, 8, 17, 6, tzinfo=UTC)),
    ).schedules[0]
    _add_override(
        store,
        override_id="replace-cross-in",
        schedule_id=recurring.id,
        occurrence_start=datetime(2026, 8, 16, 1, tzinfo=UTC),
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id=replacement.id,
    )

    result = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 16, 16, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 16, tzinfo=UTC),
        ),
    )

    assert result.schedules == (replacement,)


def test_find_schedules_excludes_replacement_that_crosses_out_of_window() -> None:
    service, store = _service()
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 1, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    replacement = service.create_schedule(
        account_id="account-a",
        command=_time_command(start_time=datetime(2026, 8, 18, 6, tzinfo=UTC)),
    ).schedules[0]
    _add_override(
        store,
        override_id="replace-cross-out",
        schedule_id=recurring.id,
        occurrence_start=datetime(2026, 8, 17, 1, tzinfo=UTC),
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id=replacement.id,
    )

    result = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 16, 16, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 16, tzinfo=UTC),
        ),
    )

    assert result.schedules == ()


def test_find_schedules_preserves_dst_and_non_dst_wall_times() -> None:
    service, _ = _service()
    new_york = service.create_schedule(
        account_id="account-a",
        command=replace(
            _time_command(
                title="New York weekly",
                start_time=datetime(2026, 1, 5, 14, tzinfo=UTC),
                schedule_kind=ScheduleKind.RECURRING,
                recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
            ),
            timezone="America/New_York",
        ),
    ).schedules[0]
    shanghai = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            title="Shanghai weekly",
            start_time=datetime(2026, 8, 3, 1, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]

    new_york_result = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 3, 9, 12, tzinfo=UTC),
            starts_before=datetime(2026, 3, 9, 14, tzinfo=UTC),
        ),
    )
    shanghai_result = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 17, 0, tzinfo=UTC),
            starts_before=datetime(2026, 8, 17, 2, tzinfo=UTC),
        ),
    )

    assert new_york in new_york_result.schedules
    assert shanghai in shanghai_result.schedules


def test_update_schedule_applies_patch_and_translates_revision_conflict() -> None:
    service, store = _service(now=NOW)
    created = service.create_schedule(account_id="account-a", command=_time_command()).schedules[0]
    later = datetime(2026, 8, 11, 2, tzinfo=UTC)
    service._clock = lambda: later

    updated = service.update_schedule(
        account_id="account-a",
        command=UpdateScheduleCommand(created.id, 1, {"title": "新标题"}),
    ).schedules[0]
    conflict = _assert_error(
        ScheduleErrorCode.REVISION_CONFLICT,
        lambda: service.update_schedule(
            account_id="account-a",
            command=UpdateScheduleCommand(created.id, 1, {"title": "过期写入"}),
        ),
    )

    assert updated.title == "新标题"
    assert updated.start_time == created.start_time
    assert updated.revision == 2
    assert updated.updated_at == later
    assert conflict.field == "expected_revision"
    assert store.schedules[created.id] == updated


def test_update_preserves_unmentioned_recurrence_rule_byte_for_byte() -> None:
    service, store = _service()
    created = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    legacy_rule = "RRULE:FREQ=WEEKLY;BYDAY=MO"
    store.schedules[created.id] = replace(created, recurrence_rule=legacy_rule)

    updated = service.update_schedule(
        account_id="account-a",
        command=UpdateScheduleCommand(created.id, 1, {"title": "项目周会"}),
    ).schedules[0]

    assert updated.title == "项目周会"
    assert updated.recurrence_rule == legacy_rule


def test_update_normalizes_explicit_recurrence_rule_change() -> None:
    service, _ = _service()
    created = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]

    updated = service.update_schedule(
        account_id="account-a",
        command=UpdateScheduleCommand(
            created.id,
            1,
            {"recurrence_rule": "RRULE:FREQ=DAILY"},
        ),
    ).schedules[0]

    assert updated.recurrence_rule == "FREQ=DAILY"


def test_update_rejects_empty_or_protected_patch_without_writing() -> None:
    service, store = _service()
    created = service.create_schedule(account_id="account-a", command=_time_command()).schedules[0]

    _assert_error(
        ScheduleErrorCode.INVALID_UPDATE_PATCH,
        lambda: service.update_schedule(
            account_id="account-a",
            command=UpdateScheduleCommand(created.id, 1, {}),
        ),
    )
    _assert_error(
        ScheduleErrorCode.INVALID_UPDATE_PATCH,
        lambda: service.update_schedule(
            account_id="account-a",
            command=UpdateScheduleCommand(
                created.id,
                1,
                {"revision": 99},  # type: ignore[typeddict-unknown-key]
            ),
        ),
    )

    assert store.schedules[created.id] == created


def test_update_translates_invalid_timezone_value_error_without_writing() -> None:
    service, store = _service()
    created = service.create_schedule(account_id="account-a", command=_time_command()).schedules[0]

    error = _assert_error(
        ScheduleErrorCode.INVALID_TIMEZONE,
        lambda: service.update_schedule(
            account_id="account-a",
            command=UpdateScheduleCommand(
                created.id,
                1,
                {"timezone": "../America/New_York"},
            ),
        ),
    )

    assert error.field == "timezone"
    assert store.schedules[created.id] == created


def test_delete_once_is_soft_account_scoped_and_kind_checked() -> None:
    service, store = _service()
    ordinary = service.create_schedule(account_id="account-a", command=_time_command()).schedules[0]
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=DAILY",
        ),
    ).schedules[0]

    deleted = service.delete_once_schedule(
        account_id="account-a",
        command=DeleteOnceScheduleCommand(ordinary.id, ordinary.revision),
    ).schedules[0]
    _assert_error(
        ScheduleErrorCode.SCHEDULE_NOT_FOUND,
        lambda: service.delete_once_schedule(
            account_id="account-b",
            command=DeleteOnceScheduleCommand(recurring.id, recurring.revision),
        ),
    )
    _assert_error(
        ScheduleErrorCode.INVALID_SCHEDULE_KIND,
        lambda: service.delete_once_schedule(
            account_id="account-a",
            command=DeleteOnceScheduleCommand(recurring.id, recurring.revision),
        ),
    )

    assert deleted.status is ScheduleStatus.DELETED
    assert deleted.deleted_at == NOW
    assert deleted.revision == 2
    assert store.schedules[ordinary.id] == deleted


def test_delete_this_occurrence_uses_current_schedule_timezone_and_skips_cancellations() -> None:
    # It is still August 10 in UTC, but already August 11 in Asia/Shanghai.
    # The August 10 occurrence must therefore be treated as yesterday.
    service, store = _service(now=datetime(2026, 8, 10, 17, tzinfo=UTC))
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]

    first = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            1,
            RecurringDeleteScope.THIS_OCCURRENCE,
        ),
    )
    second = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            2,
            RecurringDeleteScope.THIS_OCCURRENCE,
        ),
    )

    assert first.schedules[0].revision == 2
    assert first.occurrence_overrides[0].action is OccurrenceOverrideAction.CANCEL
    assert first.occurrence_overrides[0].occurrence_start == datetime(2026, 8, 17, 2, tzinfo=UTC)
    assert second.schedules[0].revision == 3
    assert second.occurrence_overrides[0].occurrence_start == datetime(2026, 8, 24, 2, tzinfo=UTC)
    assert len(store.overrides) == 2


def test_delete_this_occurrence_soft_deletes_its_existing_replacement() -> None:
    service, store = _service(now=datetime(2026, 8, 23, 16, tzinfo=UTC))
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    occurrence = datetime(2026, 8, 24, 2, tzinfo=UTC)
    replacement = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="replace-august-24",
        occurrence_start=occurrence,
        replacement_start=datetime(2026, 8, 24, 6, tzinfo=UTC),
    )

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            recurring.revision,
            RecurringDeleteScope.THIS_OCCURRENCE,
        ),
    )

    persisted_parent, persisted_replacement = result.schedules
    assert persisted_parent.revision == 2
    assert persisted_parent.status is ScheduleStatus.ACTIVE
    assert persisted_replacement.id == replacement.id
    assert persisted_replacement.status is ScheduleStatus.DELETED
    assert persisted_replacement.revision == 2
    assert result.occurrence_overrides == ()
    assert store.overrides["replace-august-24"].action is OccurrenceOverrideAction.REPLACE
    found = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 24, tzinfo=UTC),
            starts_before=datetime(2026, 8, 25, tzinfo=UTC),
        ),
    )
    assert found.schedules == ()


def test_delete_this_occurrence_keeps_new_york_wall_time_after_dst() -> None:
    service, _ = _service(now=datetime(2026, 3, 8, 16, tzinfo=UTC))
    recurring = service.create_schedule(
        account_id="account-a",
        command=replace(
            _time_command(
                start_time=datetime(2026, 1, 5, 14, tzinfo=UTC),
                schedule_kind=ScheduleKind.RECURRING,
                recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
            ),
            timezone="America/New_York",
        ),
    ).schedules[0]

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            1,
            RecurringDeleteScope.THIS_OCCURRENCE,
        ),
    )

    assert result.occurrence_overrides[0].occurrence_start == datetime(2026, 3, 9, 13, tzinfo=UTC)


def test_delete_this_and_future_uses_dst_correct_prior_occurrence() -> None:
    service, _ = _service(now=datetime(2026, 3, 8, 16, tzinfo=UTC))
    recurring = service.create_schedule(
        account_id="account-a",
        command=replace(
            _time_command(
                start_time=datetime(2026, 1, 5, 14, tzinfo=UTC),
                schedule_kind=ScheduleKind.RECURRING,
                recurrence_rule="FREQ=WEEKLY;BYDAY=MO;COUNT=20",
            ),
            timezone="America/New_York",
        ),
    ).schedules[0]

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            1,
            RecurringDeleteScope.THIS_AND_FUTURE,
        ),
    )

    assert result.schedules[0].recurrence_rule == ("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260302T140000Z")


def test_delete_this_and_future_truncates_after_last_retained_occurrence() -> None:
    service, _ = _service(now=NOW)
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO;COUNT=20",
        ),
    ).schedules[0]

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            1,
            RecurringDeleteScope.THIS_AND_FUTURE,
        ),
    )

    updated = result.schedules[0]
    assert updated.status is ScheduleStatus.ACTIVE
    assert updated.revision == 2
    assert updated.recurrence_rule == "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260810T020000Z"


def test_delete_this_and_future_uses_original_occurrence_for_replacement_ownership() -> None:
    service, store = _service(now=NOW)
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO;COUNT=20",
        ),
    ).schedules[0]
    past_moved_future = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="replace-august-10",
        occurrence_start=datetime(2026, 8, 10, 2, tzinfo=UTC),
        replacement_start=datetime(2026, 8, 24, 6, tzinfo=UTC),
    )
    future_moved_past = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="replace-august-24",
        occurrence_start=datetime(2026, 8, 24, 2, tzinfo=UTC),
        replacement_start=datetime(2026, 8, 15, 6, tzinfo=UTC),
    )
    future_replacement = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="replace-august-31",
        occurrence_start=datetime(2026, 8, 31, 2, tzinfo=UTC),
        replacement_start=datetime(2026, 8, 31, 6, tzinfo=UTC),
    )

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            recurring.revision,
            RecurringDeleteScope.THIS_AND_FUTURE,
        ),
    )

    assert result.schedules[0].recurrence_rule == ("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260810T020000Z")
    assert {schedule.id for schedule in result.schedules[1:]} == {
        future_moved_past.id,
        future_replacement.id,
    }
    assert store.schedules[past_moved_future.id].status is ScheduleStatus.ACTIVE
    assert store.schedules[past_moved_future.id].revision == 1
    assert store.schedules[future_moved_past.id].status is ScheduleStatus.DELETED
    assert store.schedules[future_moved_past.id].revision == 2
    assert store.schedules[future_replacement.id].status is ScheduleStatus.DELETED
    assert store.schedules[future_replacement.id].revision == 2

    found = service.find_schedules(
        account_id="account-a",
        query=FindSchedulesQuery(
            starts_at_or_after=datetime(2026, 8, 24, tzinfo=UTC),
            starts_before=datetime(2026, 8, 25, tzinfo=UTC),
        ),
    )
    assert found.schedules == (store.schedules[past_moved_future.id],)


def test_delete_this_and_future_on_first_occurrence_deletes_entire_series() -> None:
    service, _ = _service(now=NOW)
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 17, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            1,
            RecurringDeleteScope.THIS_AND_FUTURE,
        ),
    )

    assert result.schedules[0].status is ScheduleStatus.DELETED
    assert result.schedules[0].deleted_at == NOW


def test_delete_recurring_entire_series_and_missing_future_occurrence() -> None:
    service, store = _service(now=NOW)
    past = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=DAILY;COUNT=1",
        ),
    ).schedules[0]
    future = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 12, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=DAILY",
        ),
    ).schedules[0]

    _assert_error(
        ScheduleErrorCode.OCCURRENCE_NOT_FOUND,
        lambda: service.delete_recurring_schedule(
            account_id="account-a",
            command=DeleteRecurringScheduleCommand(
                past.id,
                1,
                RecurringDeleteScope.THIS_OCCURRENCE,
            ),
        ),
    )
    deleted = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            future.id,
            1,
            RecurringDeleteScope.ENTIRE_SERIES,
        ),
    ).schedules[0]

    assert store.schedules[past.id].revision == 1
    assert deleted.status is ScheduleStatus.DELETED
    assert deleted.revision == 2


def test_delete_entire_series_soft_deletes_all_replacements_but_keeps_overrides() -> None:
    service, store = _service(now=NOW)
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    replacements = (
        _add_replacement(
            service,
            store,
            parent_id=recurring.id,
            override_id="replace-august-10",
            occurrence_start=datetime(2026, 8, 10, 2, tzinfo=UTC),
            replacement_start=datetime(2026, 8, 10, 6, tzinfo=UTC),
        ),
        _add_replacement(
            service,
            store,
            parent_id=recurring.id,
            override_id="replace-august-24",
            occurrence_start=datetime(2026, 8, 24, 2, tzinfo=UTC),
            replacement_start=datetime(2026, 8, 24, 6, tzinfo=UTC),
        ),
    )
    _add_override(
        store,
        override_id="cancel-august-17",
        schedule_id=recurring.id,
        occurrence_start=datetime(2026, 8, 17, 2, tzinfo=UTC),
        action=OccurrenceOverrideAction.CANCEL,
    )

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            recurring.revision,
            RecurringDeleteScope.ENTIRE_SERIES,
        ),
    )

    assert result.schedules[0].id == recurring.id
    assert result.schedules[0].status is ScheduleStatus.DELETED
    assert {schedule.id for schedule in result.schedules[1:]} == {
        replacement.id for replacement in replacements
    }
    assert all(
        store.schedules[replacement.id].status is ScheduleStatus.DELETED
        for replacement in replacements
    )
    assert all(store.schedules[replacement.id].revision == 2 for replacement in replacements)
    assert set(store.overrides) == {
        "replace-august-10",
        "cancel-august-17",
        "replace-august-24",
    }
    assert result.occurrence_overrides == ()


def test_delete_entire_series_does_not_cross_account_for_replacement() -> None:
    service, store = _service(now=NOW)
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    other_account_replacement = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="inconsistent-cross-account-replacement",
        occurrence_start=datetime(2026, 8, 17, 2, tzinfo=UTC),
        replacement_start=datetime(2026, 8, 17, 6, tzinfo=UTC),
        account_id="account-b",
    )

    result = service.delete_recurring_schedule(
        account_id="account-a",
        command=DeleteRecurringScheduleCommand(
            recurring.id,
            recurring.revision,
            RecurringDeleteScope.ENTIRE_SERIES,
        ),
    )

    assert result.schedules == (store.schedules[recurring.id],)
    assert store.schedules[other_account_replacement.id].status is ScheduleStatus.ACTIVE
    assert store.schedules[other_account_replacement.id].revision == 1


def test_replacement_revision_conflict_rolls_back_parent_and_other_replacements() -> None:
    service, store = _service(now=NOW)
    recurring = service.create_schedule(
        account_id="account-a",
        command=_time_command(
            start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
            schedule_kind=ScheduleKind.RECURRING,
            recurrence_rule="FREQ=WEEKLY;BYDAY=MO",
        ),
    ).schedules[0]
    first_replacement = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="replace-august-17",
        occurrence_start=datetime(2026, 8, 17, 2, tzinfo=UTC),
        replacement_start=datetime(2026, 8, 17, 6, tzinfo=UTC),
    )
    conflicting_replacement = _add_replacement(
        service,
        store,
        parent_id=recurring.id,
        override_id="replace-august-24",
        occurrence_start=datetime(2026, 8, 24, 2, tzinfo=UTC),
        replacement_start=datetime(2026, 8, 24, 6, tzinfo=UTC),
    )

    class _ConflictRepository(_Repository):
        def update_schedule(
            self,
            *,
            snapshot: ScheduleSnapshot,
            expected_revision: int,
        ) -> ScheduleSnapshot | None:
            if snapshot.id == conflicting_replacement.id:
                raise ScheduleRevisionConflictError(
                    schedule_id=snapshot.id,
                    expected_revision=expected_revision,
                    actual_revision=expected_revision + 1,
                )
            return super().update_schedule(
                snapshot=snapshot,
                expected_revision=expected_revision,
            )

    class _ConflictUnitOfWork(_UnitOfWork):
        def __init__(self, committed: _Store) -> None:
            super().__init__(committed)
            self.schedules = _ConflictRepository(self._working)

    deleting_service = ScheduleApplicationService(
        lambda: _ConflictUnitOfWork(store),
        clock=lambda: NOW,
        id_factory=lambda: "unused-id",
    )

    _assert_error(
        ScheduleErrorCode.REVISION_CONFLICT,
        lambda: deleting_service.delete_recurring_schedule(
            account_id="account-a",
            command=DeleteRecurringScheduleCommand(
                recurring.id,
                recurring.revision,
                RecurringDeleteScope.ENTIRE_SERIES,
            ),
        ),
    )

    assert store.schedules[recurring.id] == recurring
    assert store.schedules[first_replacement.id] == first_replacement
    assert store.schedules[conflicting_replacement.id] == conflicting_replacement
