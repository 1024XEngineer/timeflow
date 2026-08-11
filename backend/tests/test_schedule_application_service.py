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


def _assert_error(
    expected: ScheduleErrorCode,
    operation: Callable[[], object],
) -> ScheduleBusinessError:
    with pytest.raises(ScheduleBusinessError) as raised:
        operation()
    assert raised.value.code is expected
    return raised.value


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


def test_delete_this_occurrence_uses_current_schedule_timezone_and_skips_overrides() -> None:
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
