"""Integration test: the SQLAlchemy schedules adapter against a real schema."""

from collections.abc import Iterator
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from timeflow.business.schedules.time_window_trigger import TimeWindowTriggerService
from timeflow.data.database import Base
from timeflow.data.models import Schedule
from timeflow.data.schedule_query import SqlAlchemyScheduleQueryAdapter


@pytest.fixture
def session() -> Iterator[Session]:
    """A schedules schema created from the real ORM metadata, backed by SQLite."""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db_session:
        yield db_session


def _make_schedule(**overrides: object) -> Schedule:
    now = datetime(2026, 7, 29, 12, 0).isoformat()
    defaults: dict[str, object] = {
        "id": "schedule_default",
        "user_id": "default_user",
        "source_mode": "manual",
        "schedule_type": "time",
        "status": "scheduled",
        "title": "test schedule",
        "geofence_radius_meters": 100,
        "geofence_armed": 1,
        "time_remind_offset_minutes": 15,
        "created_at": now,
        "updated_at": now,
    }
    defaults.update(overrides)
    return Schedule(**defaults)  # type: ignore[arg-type]


def test_adapter_returns_schedules_entering_their_time_window(session: Session) -> None:
    """A due schedule row, inserted through the real ORM model, is found via the adapter."""
    start_time = datetime(2026, 7, 29, 15, 0)
    session.add(
        _make_schedule(
            id="schedule_due",
            start_time=start_time.isoformat(),
            time_remind_offset_minutes=15,
        )
    )
    session.commit()

    adapter = SqlAlchemyScheduleQueryAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=start_time - timedelta(minutes=15))

    assert result == ["schedule_due"]


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

    adapter = SqlAlchemyScheduleQueryAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=datetime(2026, 7, 29, 15, 0))

    assert result == []


def test_adapter_excludes_done_and_deleted_schedules(session: Session) -> None:
    """Rows that are no longer scheduled are filtered out at the query level."""
    start_time = datetime(2026, 7, 29, 15, 0)
    session.add_all(
        [
            _make_schedule(id="schedule_done", status="done", start_time=start_time.isoformat()),
            _make_schedule(
                id="schedule_deleted", status="deleted", start_time=start_time.isoformat()
            ),
        ]
    )
    session.commit()

    adapter = SqlAlchemyScheduleQueryAdapter(session)
    service = TimeWindowTriggerService(adapter)

    result = service.find_schedules_entering_window(now=start_time)

    assert result == []
