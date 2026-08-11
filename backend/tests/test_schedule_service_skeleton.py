"""Contract tests for the person-two schedule service skeleton."""

import json
from datetime import UTC, datetime
from inspect import Parameter, signature

import pytest

from timeflow.business.calendar import (
    CreateScheduleCommand,
    DeleteOnceScheduleCommand,
    DeleteRecurringScheduleCommand,
    FindSchedulesQuery,
    RecurringDeleteScope,
    ReminderDispositionState,
    ScheduleAgentService,
    ScheduleBusinessError,
    ScheduleErrorCode,
    ScheduleKind,
    ScheduleMutationResult,
    ScheduleSearchResult,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
    ScheduleUpdatePatch,
    UpdateScheduleCommand,
)


def test_agent_schedule_service_exposes_exactly_five_business_operations() -> None:
    """The first collaboration skeleton keeps the agreed Agent boundary stable."""

    operations = {
        name
        for name, value in ScheduleAgentService.__dict__.items()
        if callable(value) and getattr(value, "__isabstractmethod__", False)
    }
    assert operations == {
        "create_schedule",
        "find_schedules",
        "update_schedule",
        "delete_once_schedule",
        "delete_recurring_schedule",
    }


def test_agent_schedule_service_keeps_all_five_public_signatures_stable() -> None:
    """Agent integration code can keep calling the already-merged contract unchanged."""

    expected = {
        "create_schedule": ("command", CreateScheduleCommand, ScheduleMutationResult),
        "find_schedules": ("query", FindSchedulesQuery, ScheduleSearchResult),
        "update_schedule": ("command", UpdateScheduleCommand, ScheduleMutationResult),
        "delete_once_schedule": (
            "command",
            DeleteOnceScheduleCommand,
            ScheduleMutationResult,
        ),
        "delete_recurring_schedule": (
            "command",
            DeleteRecurringScheduleCommand,
            ScheduleMutationResult,
        ),
    }

    for operation, (input_name, input_type, return_type) in expected.items():
        operation_signature = signature(getattr(ScheduleAgentService, operation))
        assert list(operation_signature.parameters) == ["self", "account_id", input_name]
        account = operation_signature.parameters["account_id"]
        command = operation_signature.parameters[input_name]
        assert account.kind is Parameter.KEYWORD_ONLY
        assert account.annotation is str
        assert command.kind is Parameter.KEYWORD_ONLY
        assert command.annotation is input_type
        assert operation_signature.return_annotation is return_type


def test_recurring_delete_scope_matches_the_three_wiki_wire_values() -> None:
    """Recurring deletion scopes serialize exactly as the v3.10 Wiki defines."""

    assert list(RecurringDeleteScope) == [
        RecurringDeleteScope.THIS_OCCURRENCE,
        RecurringDeleteScope.THIS_AND_FUTURE,
        RecurringDeleteScope.ENTIRE_SERIES,
    ]
    assert [scope.value for scope in RecurringDeleteScope] == [
        "this_occurrence",
        "this_and_future",
        "entire_series",
    ]


def test_reminder_disposition_state_matches_the_cloud_snapshot_contract() -> None:
    """Cloud snapshots accept only confirmed or no final disposition state."""

    now = datetime.now(UTC)
    confirmed_snapshot = ScheduleSnapshot(
        id="schedule-confirmed",
        account_id="account-1",
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title="Confirmed reminder",
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=ScheduleStatus.ACTIVE,
        revision=1,
        created_at=now,
        updated_at=now,
        reminder_disposition_state=ReminderDispositionState.CONFIRMED,
    )
    empty_snapshot = ScheduleSnapshot(
        id="schedule-empty",
        account_id="account-1",
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.ONCE,
        title="No disposition",
        is_all_day=False,
        timezone="Asia/Shanghai",
        status=ScheduleStatus.ACTIVE,
        revision=1,
        created_at=now,
        updated_at=now,
        reminder_disposition_state=None,
    )

    assert ReminderDispositionState.CONFIRMED.value == "confirmed"
    assert json.dumps(ReminderDispositionState.CONFIRMED) == '"confirmed"'
    assert confirmed_snapshot.reminder_disposition_state is ReminderDispositionState.CONFIRMED
    assert empty_snapshot.reminder_disposition_state is None


def test_reminder_disposition_state_rejects_local_only_values() -> None:
    """Local snooze state cannot be represented as a cloud disposition enum."""

    with pytest.raises(ValueError):
        ReminderDispositionState("snoozed")


def test_update_patch_exposes_only_explicitly_mutable_fields() -> None:
    """Identity, ownership, lifecycle, revision, and audit fields stay protected."""

    assert ScheduleUpdatePatch.__required_keys__ == frozenset()
    assert ScheduleUpdatePatch.__optional_keys__ == {
        "title",
        "is_all_day",
        "start_time",
        "end_time",
        "timezone",
        "recurrence_rule",
        "location_name",
        "latitude",
        "longitude",
        "reminder_type",
        "reminder_trigger_at",
        "reminder_offset_minutes",
        "reminder_strength",
    }

    command = UpdateScheduleCommand(
        schedule_id="schedule-1",
        expected_revision=3,
        changes={"title": "Updated title", "location_name": None},
    )

    assert command.changes == {"title": "Updated title", "location_name": None}


def test_business_error_has_stable_machine_readable_context() -> None:
    """Agent adapters can translate expected failures without parsing messages."""

    error = ScheduleBusinessError(
        code=ScheduleErrorCode.REVISION_CONFLICT,
        message="The schedule revision is stale.",
        schedule_id="schedule-1",
        field="expected_revision",
    )

    assert str(error) == "The schedule revision is stale."
    assert error.code is ScheduleErrorCode.REVISION_CONFLICT
    assert error.schedule_id == "schedule-1"
    assert error.field == "expected_revision"


def test_business_error_codes_are_stable() -> None:
    """All agreed failure categories remain explicit at the service boundary."""

    assert {code.value for code in ScheduleErrorCode} == {
        "schedule_not_found",
        "revision_conflict",
        "occurrence_not_found",
        "invalid_timezone",
        "invalid_update_patch",
        "invalid_schedule_kind",
        "validation_failed",
    }
