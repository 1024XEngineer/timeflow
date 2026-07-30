"""Integration test: the SQLAlchemy dispatch command adapter against a real schema."""

from collections.abc import Iterator
from datetime import datetime

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from timeflow.data.database import Base
from timeflow.data.models import Schedule
from timeflow.data.schedule_dispatch_command import SqlAlchemyScheduleDispatchCommandAdapter


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


def test_mark_triggered_writes_time_triggered_at(session: Session) -> None:
    """mark_triggered 写入 ISO 格式的触发时间。"""
    session.add(_make_schedule(id="schedule_1"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchCommandAdapter(session)
    triggered_at = datetime(2026, 7, 29, 14, 45)

    adapter.mark_triggered("schedule_1", triggered_at)
    session.commit()

    assert _reload(session, "schedule_1").time_triggered_at == triggered_at.isoformat()


def test_cancel_marks_status_deleted(session: Session) -> None:
    """cancel 把日程状态改成 deleted。"""
    session.add(_make_schedule(id="schedule_2"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchCommandAdapter(session)

    adapter.cancel("schedule_2")
    session.commit()

    assert _reload(session, "schedule_2").status == "deleted"


def test_clear_system_schedule_ref_sets_null(session: Session) -> None:
    """clear_system_schedule_ref 把系统日历引用清空。"""
    session.add(_make_schedule(id="schedule_3", system_schedule_ref_id="system_schedule_3"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchCommandAdapter(session)

    adapter.clear_system_schedule_ref("schedule_3")
    session.commit()

    assert _reload(session, "schedule_3").system_schedule_ref_id is None
