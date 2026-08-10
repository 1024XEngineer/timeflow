"""Contract tests for the person-two schedule service skeleton."""

from timeflow.business.calendar import (
    RecurringDeleteScope,
    ScheduleAgentService,
    ScheduleBusinessError,
    ScheduleErrorCode,
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


def test_recurring_delete_scope_has_only_the_two_agreed_choices() -> None:
    """Callers cannot select an arbitrary recurring occurrence or date range."""

    assert list(RecurringDeleteScope) == [
        RecurringDeleteScope.NEXT_OCCURRENCE,
        RecurringDeleteScope.NEXT_AND_FUTURE,
    ]


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
