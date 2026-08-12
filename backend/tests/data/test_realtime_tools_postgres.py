"""The realtime model's tools driving the real database, end to end."""

import asyncio
import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from timeflow.business.calendar.service import ScheduleApplicationService
from timeflow.data.database import build_session_factory
from timeflow.data.schedule_unit_of_work import SqlAlchemyScheduleUnitOfWork
from timeflow.intelligence.realtime.schedule_tools import (
    REQUEST_USER_INPUT,
    SCHEDULE_CREATE,
    SCHEDULE_DELETE,
    SCHEDULE_QUERY,
    SCHEDULE_UPDATE,
    ToolBox,
    ToolResult,
)

ACCOUNT = "acct-tools-test"
OTHER_ACCOUNT = "acct-tools-other"
# A Monday, so "下周一" in a test reads the way a user would mean it.
NOW = datetime(2026, 9, 7, 9, 0)


def _service(factory: sessionmaker[Session]) -> ScheduleApplicationService:
    """Build the application service the way the composition root does."""
    return ScheduleApplicationService(lambda: SqlAlchemyScheduleUnitOfWork(factory))


@pytest.fixture(scope="module")
def engine() -> Iterator[Engine]:
    """Connect only when an explicit disposable integration database is supplied."""
    database_url = os.getenv("TIMEFLOW_TEST_DATABASE_URL")
    if database_url is None:
        pytest.skip("TIMEFLOW_TEST_DATABASE_URL is not set")
    built = sa.create_engine(database_url)
    try:
        yield built
    finally:
        built.dispose()


@pytest.fixture
def toolbox(engine: Engine) -> Iterator[ToolBox]:
    """A toolbox bound to one account, on a fixed clock, over the real database."""
    factory = build_session_factory(engine)
    created_at = datetime.now(UTC)
    with factory() as session:
        for account_id in (ACCOUNT, OTHER_ACCOUNT):
            session.execute(
                sa.text(
                    "INSERT INTO accounts (id, username, password_hash, created_at, updated_at) "
                    "VALUES (:id, :username, 'test-hash', :now, :now) "
                    "ON CONFLICT (id) DO NOTHING"
                ),
                {"id": account_id, "username": f"{account_id}-user", "now": created_at},
            )
        session.commit()
    try:
        yield ToolBox(ACCOUNT, _service(factory), now=lambda: NOW)
    finally:
        with factory() as session:
            session.execute(
                sa.text("DELETE FROM schedules WHERE account_id = ANY(:accounts)"),
                {"accounts": [ACCOUNT, OTHER_ACCOUNT]},
            )
            session.execute(
                sa.text("DELETE FROM accounts WHERE id = ANY(:accounts)"),
                {"accounts": [ACCOUNT, OTHER_ACCOUNT]},
            )
            session.commit()


def call(toolbox: ToolBox, name: str, **arguments: Any) -> ToolResult:
    """Run one tool the way the agent runs it, from outside a running loop."""
    return asyncio.run(toolbox.run(name, arguments))


def output_of(result: ToolResult) -> dict[str, Any]:
    """The JSON the model is handed back."""
    parsed: dict[str, Any] = json.loads(result.output)
    return parsed


def test_creating_a_schedule_persists_it_and_tells_both_sides(toolbox: ToolBox) -> None:
    """A create reaches the database and reports back to model and client alike."""
    result = call(
        toolbox,
        SCHEDULE_CREATE,
        schedule_type="time",
        schedule_kind="once",
        title="明天下午三点开会",
        start_time="2026-09-08T15:00:00",
        end_time="2026-09-08T16:00:00",
        reminder_type="before_start",
        reminder_offset_minutes=15,
        reminder_strength="medium",
    )

    assert result.question is None
    assert output_of(result)["status"] == "applied"
    assert result.outcome is not None
    assert result.outcome["operation"] == "create_schedule"
    assert result.outcome["status"] == "applied"
    persisted = result.outcome["schedule"]
    assert persisted["title"] == "明天下午三点开会"
    assert persisted["revision"] == 1
    # The client is told about the schedule, never about who owns it or when the row moved.
    assert "account_id" not in persisted
    assert "created_at" not in persisted

    found = call(toolbox, SCHEDULE_QUERY, title="开会")
    assert output_of(found)["count"] == 1


def test_a_naive_local_time_is_stored_as_the_instant_it_names(toolbox: ToolBox) -> None:
    """A time spoken without a zone means local time, not UTC."""
    call(
        toolbox,
        SCHEDULE_CREATE,
        schedule_type="time",
        schedule_kind="once",
        title="七点晨跑",
        start_time="2026-09-08T07:00:00",
    )

    found = call(toolbox, SCHEDULE_QUERY, title="晨跑")

    (schedule,) = output_of(found)["schedules"]
    # Read back as the wall clock the user spoke, not shifted by the zone offset.
    assert schedule["starts_at_local"] == "2026-09-08 07:00"


def test_a_query_only_ever_sees_the_bound_account(engine: Engine, toolbox: ToolBox) -> None:
    """The toolbox is bound to one account and cannot be asked about another."""
    other = ToolBox(
        OTHER_ACCOUNT,
        _service(build_session_factory(engine)),
        now=lambda: NOW,
    )
    call(
        other,
        SCHEDULE_CREATE,
        schedule_type="time",
        schedule_kind="once",
        title="别人的安排",
        start_time="2026-09-08T15:00:00",
    )

    found = call(toolbox, SCHEDULE_QUERY, title="别人的安排")

    assert output_of(found)["count"] == 0


def _created_id(toolbox: ToolBox, title: str = "去公司开会") -> tuple[str, int]:
    """Create one schedule and return what an update needs to address it."""
    result = call(
        toolbox,
        SCHEDULE_CREATE,
        schedule_type="time",
        schedule_kind="once",
        title=title,
        start_time="2026-09-08T15:00:00",
    )
    assert result.outcome is not None
    created = result.outcome["schedule"]
    schedule_id: str = created["id"]
    revision: int = created["revision"]
    return schedule_id, revision


def test_an_update_reaches_the_database_and_moves_the_revision(toolbox: ToolBox) -> None:
    """The model can change a schedule it just created."""
    schedule_id, revision = _created_id(toolbox)

    result = call(
        toolbox,
        SCHEDULE_UPDATE,
        schedule_id=schedule_id,
        expected_revision=revision,
        changes={"title": "改到下午四点开会", "start_time": "2026-09-08T16:00:00"},
    )

    assert result.outcome is not None
    updated = result.outcome["schedule"]
    assert updated["title"] == "改到下午四点开会"
    assert updated["revision"] == revision + 1


def test_a_stale_revision_comes_back_as_a_conflict_the_model_can_read(
    toolbox: ToolBox,
) -> None:
    """A revision that moved on is reported as a conflict, not applied."""
    schedule_id, revision = _created_id(toolbox)
    call(
        toolbox,
        SCHEDULE_UPDATE,
        schedule_id=schedule_id,
        expected_revision=revision,
        changes={"title": "先改一次"},
    )

    result = call(
        toolbox,
        SCHEDULE_UPDATE,
        schedule_id=schedule_id,
        expected_revision=revision,
        changes={"title": "再改一次"},
    )

    reported = output_of(result)
    assert reported["status"] == "failed"
    assert reported["error"]["code"] == "revision_conflict"
    # Nothing was committed, so the client is sent no command result at all.
    assert result.outcome is None


def test_a_delete_takes_the_schedule_out_of_what_the_model_can_find(
    toolbox: ToolBox,
) -> None:
    """Deleting removes it from later queries."""
    schedule_id, revision = _created_id(toolbox)

    result = call(
        toolbox,
        SCHEDULE_DELETE,
        schedule_id=schedule_id,
        expected_revision=revision,
        schedule_kind="once",
    )

    assert output_of(result)["status"] == "applied"
    assert output_of(call(toolbox, SCHEDULE_QUERY))["count"] == 0


def test_a_schedule_the_database_will_not_accept_is_refused_not_half_written(
    toolbox: ToolBox,
) -> None:
    """A location schedule with no coordinates is refused and leaves nothing behind."""
    result = call(
        toolbox,
        SCHEDULE_CREATE,
        schedule_type="location",
        schedule_kind="once",
        title="到了公司提醒我",
        location_name="公司",
    )

    assert output_of(result)["status"] == "failed"
    assert output_of(call(toolbox, SCHEDULE_QUERY))["count"] == 0


def test_deleting_something_that_is_not_there_is_reported_not_raised(
    toolbox: ToolBox,
) -> None:
    """A missing schedule reads as not found, and the turn carries on."""
    result = call(
        toolbox,
        SCHEDULE_DELETE,
        schedule_id="sch_nothing_here",
        expected_revision=1,
        schedule_kind="once",
    )

    assert output_of(result)["error"]["code"] == "schedule_not_found"


def test_asking_the_user_never_touches_the_database(toolbox: ToolBox) -> None:
    """A question is asked, not applied: nothing is written."""
    result = call(
        toolbox,
        REQUEST_USER_INPUT,
        question_kind="missing_field",
        speech_text="是明天下午三点吗？",
        required_response="start_time",
    )

    assert result.question is not None
    assert result.question["speech_text"] == "是明天下午三点吗？"
    assert result.outcome is None
    assert output_of(call(toolbox, SCHEDULE_QUERY))["count"] == 0


def test_disambiguating_without_candidates_is_refused(toolbox: ToolBox) -> None:
    """Asking which one without offering any is a question the user cannot answer."""
    result = call(
        toolbox,
        REQUEST_USER_INPUT,
        question_kind="ambiguous_target",
        speech_text="你说的是哪一个？",
    )

    assert result.question is None
    assert output_of(result)["status"] == "failed"
