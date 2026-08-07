"""Contract tests for the person-two schedule service skeleton."""

from timeflow.business.calendar import RecurringDeleteScope, ScheduleAgentService


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
