"""Integration test: the SQLAlchemy schedule dispatch adapter against a real schema."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from timeflow.business.reminders.time_window_trigger import TimeWindowTriggerService
from timeflow.data.database import Base
from timeflow.data.models import Schedule
from timeflow.data.schedule_dispatch import SqlAlchemyScheduleDispatchAdapter


@pytest.fixture
def session() -> Iterator[Session]:
    """A schedules schema created from the real ORM metadata, backed by SQLite."""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db_session:
        yield db_session


def _make_schedule(**overrides: object) -> Schedule:
    now = datetime(2026, 7, 29, 12, 0, tzinfo=UTC).isoformat()
    defaults: dict[str, object] = {
        "id": "schedule_default",
        "user_id": "default_user",
        "source_mode": "manual",
        "schedule_type": "time",
        "status": "scheduled",
        "title": "test schedule",
        "start_time": now,
        "geofence_radius_meters": 100,
        "geofence_armed": 1,
        "time_remind_offset_minutes": 15,
        "created_at": now,
        "updated_at": now,
    }
    defaults.update(overrides)
    return Schedule(**defaults)  # type: ignore[arg-type]


def _reload(session: Session, schedule_id: str) -> Schedule:
    result = session.execute(select(Schedule).where(Schedule.id == schedule_id)).scalar_one()
    return result


def test_adapter_returns_schedules_entering_their_time_window(session: Session) -> None:
    """A due schedule row, inserted through the real ORM model, is found via the adapter."""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    session.add(
        _make_schedule(
            id="schedule_due",
            start_time=start_time.isoformat(),
            time_remind_offset_minutes=15,
        )
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=start_time - timedelta(minutes=15))

    assert [schedule.id for schedule in result] == ["schedule_due"]


def test_adapter_excludes_location_only_schedules(session: Session) -> None:
    """A location-only row (no start_time) is filtered out at the query level."""
    session.add(
        _make_schedule(
            id="schedule_location",
            schedule_type="location",
            start_time=None,
            latitude=31.2451,
            longitude=121.5067,
        )
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=datetime(2026, 7, 29, 15, 0, tzinfo=UTC))

    assert result == []


def test_adapter_excludes_done_and_deleted_schedules(session: Session) -> None:
    """Rows that are no longer scheduled are filtered out at the query level."""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    session.add_all(
        [
            _make_schedule(id="schedule_done", status="done", start_time=start_time.isoformat()),
            _make_schedule(
                id="schedule_deleted", status="deleted", start_time=start_time.isoformat()
            ),
        ]
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=start_time)

    assert result == []


def test_adapter_excludes_already_triggered_schedules(session: Session) -> None:
    """A schedule with `time_triggered_at` already set is not re-picked-up."""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    session.add(
        _make_schedule(
            id="schedule_already_triggered",
            start_time=start_time.isoformat(),
            time_triggered_at=start_time.isoformat(),
        )
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=start_time)

    assert result == []


def test_adapter_carries_user_id_and_system_schedule_ref_id(session: Session) -> None:
    """The record exposes `user_id` and `system_schedule_ref_id` for downstream dispatch."""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    session.add(
        _make_schedule(
            id="schedule_with_ref",
            user_id="user_42",
            start_time=start_time.isoformat(),
            system_schedule_ref_id="system_schedule_42",
        )
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    service = TimeWindowTriggerService(adapter)

    records = service.find_schedules_entering_window(now=start_time)

    assert len(records) == 1
    assert records[0].user_id == "user_42"
    assert records[0].system_schedule_ref_id == "system_schedule_42"


def test_mark_time_triggered_writes_time_triggered_at(session: Session) -> None:
    """第一次调用写入 ISO 格式的触发时间,并返回 True。"""
    session.add(_make_schedule(id="schedule_1"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    triggered_at = datetime(2026, 7, 29, 14, 45, tzinfo=UTC)

    wrote = adapter.mark_time_triggered("schedule_1", triggered_at)
    session.commit()

    assert wrote is True
    assert _reload(session, "schedule_1").time_triggered_at == triggered_at.isoformat()


def test_mark_time_triggered_is_idempotent(session: Session) -> None:
    """已经写过 time_triggered_at 的日程,再次调用不会覆盖,返回 False。"""
    session.add(_make_schedule(id="schedule_2"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    first_triggered_at = datetime(2026, 7, 29, 14, 45, tzinfo=UTC)
    second_triggered_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)

    adapter.mark_time_triggered("schedule_2", first_triggered_at)
    session.commit()
    wrote_again = adapter.mark_time_triggered("schedule_2", second_triggered_at)
    session.commit()

    assert wrote_again is False
    assert _reload(session, "schedule_2").time_triggered_at == first_triggered_at.isoformat()
