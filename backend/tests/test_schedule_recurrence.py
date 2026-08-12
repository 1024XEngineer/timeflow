"""Strict RRULE and timezone-aware recurrence behavior tests."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from timeflow.business.calendar import (
    OccurrenceOverrideAction,
    ScheduleKind,
    ScheduleOccurrenceOverrideSnapshot,
    ScheduleSnapshot,
    ScheduleStatus,
    ScheduleType,
)
from timeflow.business.calendar.recurrence import (
    InvalidRecurrenceRuleError,
    first_active_occurrence_on_or_after_local_date,
    first_occurrence_in_window,
    normalize_recurrence_rule,
    parse_recurrence_rule,
    truncate_rule_before_occurrence,
)


def _recurring_schedule(
    *,
    timezone: str,
    start_time: datetime,
    recurrence_rule: str = "FREQ=WEEKLY;BYDAY=MO",
) -> ScheduleSnapshot:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return ScheduleSnapshot(
        id="recurring-schedule",
        account_id="account-a",
        schedule_type=ScheduleType.TIME,
        schedule_kind=ScheduleKind.RECURRING,
        title="Weekly sync",
        is_all_day=False,
        timezone=timezone,
        status=ScheduleStatus.ACTIVE,
        revision=1,
        created_at=now,
        updated_at=now,
        start_time=start_time,
        recurrence_rule=recurrence_rule,
    )


@pytest.mark.parametrize(
    "rule",
    [
        "FREQ=DAILY",
        "FREQ=WEEKLY;BYDAY=MO,WE",
        "FREQ=MONTHLY;INTERVAL=2",
    ],
)
def test_single_rrule_bodies_are_accepted(rule: str) -> None:
    local_start = datetime(2026, 1, 5, 9, tzinfo=ZoneInfo("America/New_York"))

    parsed = parse_recurrence_rule(rule, start_time=local_start)

    assert parsed.after(local_start, inc=True) is not None


def test_one_rrule_prefix_is_normalized_to_the_contract_body() -> None:
    assert normalize_recurrence_rule("RRULE:FREQ=WEEKLY;BYDAY=MO") == ("FREQ=WEEKLY;BYDAY=MO")


@pytest.mark.parametrize(
    "rule",
    [
        "RDATE:20260810T090000Z",
        "EXDATE:20260810T090000Z",
        "EXRULE:FREQ=WEEKLY",
        "DTSTART:20260810T090000Z",
        "RRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY",
        "RRULE:FREQ=DAILY\nRDATE:20260810T090000Z",
        "",
        "FREQ=NOT_A_FREQUENCY",
    ],
)
def test_recurrence_sets_and_non_rrule_content_are_rejected(rule: str) -> None:
    local_start = datetime(2026, 1, 5, 9, tzinfo=ZoneInfo("America/New_York"))

    with pytest.raises(InvalidRecurrenceRuleError):
        parse_recurrence_rule(rule, start_time=local_start)


def test_new_york_weekly_occurrences_keep_nine_am_across_dst() -> None:
    timezone = ZoneInfo("America/New_York")
    schedule = _recurring_schedule(
        timezone=timezone.key,
        start_time=datetime(2026, 1, 5, 14, tzinfo=UTC),
    )

    before_dst = first_active_occurrence_on_or_after_local_date(
        schedule,
        now=datetime(2026, 3, 1, 12, tzinfo=UTC),
        overrides=(),
    )
    after_dst = first_active_occurrence_on_or_after_local_date(
        schedule,
        now=datetime(2026, 3, 8, 16, tzinfo=UTC),
        overrides=(),
    )

    assert before_dst == datetime(2026, 3, 2, 14, tzinfo=UTC)
    assert after_dst == datetime(2026, 3, 9, 13, tzinfo=UTC)
    assert before_dst.astimezone(timezone).hour == 9
    assert after_dst.astimezone(timezone).hour == 9
    assert before_dst.astimezone(timezone).utcoffset().total_seconds() == -5 * 3600
    assert after_dst.astimezone(timezone).utcoffset().total_seconds() == -4 * 3600


def test_this_and_future_cutoff_uses_the_dst_correct_prior_occurrence() -> None:
    schedule = _recurring_schedule(
        timezone="America/New_York",
        start_time=datetime(2026, 1, 5, 14, tzinfo=UTC),
        recurrence_rule="FREQ=WEEKLY;BYDAY=MO;COUNT=20",
    )
    occurrence = first_active_occurrence_on_or_after_local_date(
        schedule,
        now=datetime(2026, 3, 8, 16, tzinfo=UTC),
        overrides=(),
    )

    assert occurrence == datetime(2026, 3, 9, 13, tzinfo=UTC)
    assert truncate_rule_before_occurrence(schedule, occurrence) == (
        "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260302T140000Z"
    )


def test_shanghai_occurrence_keeps_its_non_dst_wall_time() -> None:
    timezone = ZoneInfo("Asia/Shanghai")
    schedule = _recurring_schedule(
        timezone=timezone.key,
        start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
    )

    occurrence = first_active_occurrence_on_or_after_local_date(
        schedule,
        now=datetime(2026, 8, 10, 17, tzinfo=UTC),
        overrides=(),
    )

    assert occurrence == datetime(2026, 8, 17, 2, tzinfo=UTC)
    assert occurrence.astimezone(timezone).hour == 10


def test_delete_selection_keeps_replaced_original_but_skips_cancelled_occurrence() -> None:
    schedule = _recurring_schedule(
        timezone="Asia/Shanghai",
        start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
    )
    now = datetime(2026, 8, 11, 1, tzinfo=UTC)
    replaced = ScheduleOccurrenceOverrideSnapshot(
        id="replace-august-17",
        schedule_id=schedule.id,
        occurrence_start=datetime(2026, 8, 17, 2, tzinfo=UTC),
        action=OccurrenceOverrideAction.REPLACE,
        replacement_schedule_id="replacement-august-17",
        created_at=now,
        updated_at=now,
    )
    cancelled = ScheduleOccurrenceOverrideSnapshot(
        id="cancel-august-17",
        schedule_id=schedule.id,
        occurrence_start=datetime(2026, 8, 17, 2, tzinfo=UTC),
        action=OccurrenceOverrideAction.CANCEL,
        created_at=now,
        updated_at=now,
    )

    replaced_occurrence = first_active_occurrence_on_or_after_local_date(
        schedule,
        now=now,
        overrides=(replaced,),
    )
    after_cancel = first_active_occurrence_on_or_after_local_date(
        schedule,
        now=now,
        overrides=(cancelled,),
    )

    assert replaced_occurrence == datetime(2026, 8, 17, 2, tzinfo=UTC)
    assert after_cancel == datetime(2026, 8, 24, 2, tzinfo=UTC)


def test_occurrence_window_is_lower_inclusive_and_upper_exclusive() -> None:
    schedule = _recurring_schedule(
        timezone="Asia/Shanghai",
        start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
    )

    at_lower = first_occurrence_in_window(
        schedule,
        starts_at_or_after=datetime(2026, 8, 17, 2, tzinfo=UTC),
        starts_before=datetime(2026, 8, 24, 2, tzinfo=UTC),
        excluded_occurrence_starts=frozenset(),
    )
    before_upper = first_occurrence_in_window(
        schedule,
        starts_at_or_after=None,
        starts_before=datetime(2026, 8, 17, 2, tzinfo=UTC),
        excluded_occurrence_starts=frozenset(),
    )

    assert at_lower == datetime(2026, 8, 17, 2, tzinfo=UTC)
    assert before_upper == datetime(2026, 8, 10, 2, tzinfo=UTC)


def test_occurrence_window_skips_overridden_starts_without_replaying_history() -> None:
    schedule = _recurring_schedule(
        timezone="Asia/Shanghai",
        start_time=datetime(2026, 8, 3, 2, tzinfo=UTC),
    )
    overridden = datetime(2026, 8, 17, 2, tzinfo=UTC)

    occurrence = first_occurrence_in_window(
        schedule,
        starts_at_or_after=overridden,
        starts_before=datetime(2026, 8, 31, 2, tzinfo=UTC),
        excluded_occurrence_starts=frozenset({overridden}),
    )

    assert occurrence == datetime(2026, 8, 24, 2, tzinfo=UTC)
