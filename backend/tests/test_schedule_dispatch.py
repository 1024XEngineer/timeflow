"""Integration test: the SQLAlchemy schedule dispatch adapter against a real schema."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from timeflow.business.reminders.geofence_trigger import GeofenceTriggerService
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


def _make_location_schedule(**overrides: object) -> Schedule:
    defaults: dict[str, object] = {
        "schedule_type": "location",
        "start_time": None,
        "latitude": 31.2451,
        "longitude": 121.5067,
    }
    defaults.update(overrides)
    return _make_schedule(**defaults)


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


def test_list_geofence_schedules_returns_located_schedules_for_the_user(session: Session) -> None:
    """只返回该用户名下、有经纬度、scheduled、还没触发过地理提醒的日程。"""
    session.add_all(
        [
            _make_location_schedule(id="schedule_geo_1", user_id="user_1"),
            _make_location_schedule(id="schedule_geo_other_user", user_id="user_2"),
            _make_schedule(id="schedule_time_only", user_id="user_1"),  # 没有经纬度
            _make_location_schedule(
                id="schedule_geo_already_triggered",
                user_id="user_1",
                geo_triggered_at=datetime(2026, 7, 29, 12, 0, tzinfo=UTC).isoformat(),
            ),
        ]
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    service = GeofenceTriggerService(adapter)

    transitions = service.find_geofence_transitions("user_1", 31.2451, 121.5067)

    assert [schedule.id for schedule, _ in transitions] == ["schedule_geo_1"]


def test_mark_done_closes_a_scheduled_row(session: Session) -> None:
    """提醒被确认后置为 done,并刷新 updated_at。"""
    session.add(_make_schedule(id="schedule_1"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    acked_at = datetime(2026, 7, 29, 15, 30, tzinfo=UTC)

    marked = adapter.mark_done("schedule_1", acked_at)
    session.commit()

    assert marked is True
    reloaded = _reload(session, "schedule_1")
    assert reloaded.status == "done"
    assert reloaded.updated_at == acked_at.isoformat()


def test_mark_done_does_not_resurrect_a_deleted_schedule(session: Session) -> None:
    """已删除的日程不能被这条路径改回 done——迟到的 ack 不应该让它复活。"""
    session.add(_make_schedule(id="schedule_deleted", status="deleted"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)

    marked = adapter.mark_done("schedule_deleted", datetime(2026, 7, 29, 15, 30, tzinfo=UTC))
    session.commit()

    assert marked is False
    assert _reload(session, "schedule_deleted").status == "deleted"


def test_done_schedule_stops_being_listened_to(session: Session) -> None:
    """置为 done 之后,时间维度和地理围栏两条链路都不该再扫到它(架构设计.md §8.4)。"""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    session.add(_make_schedule(id="schedule_time", start_time=start_time.isoformat()))
    session.add(_make_location_schedule(id="schedule_geo"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    adapter.mark_done("schedule_time", start_time)
    adapter.mark_done("schedule_geo", start_time)
    session.commit()

    time_hits = TimeWindowTriggerService(adapter).find_schedules_entering_window(now=start_time)
    geo_hits = GeofenceTriggerService(adapter).find_geofence_transitions(
        "default_user", 31.2451, 121.5067
    )

    assert time_hits == []
    assert geo_hits == []


def test_geofence_query_excludes_schedules_that_also_have_a_start_time(session: Session) -> None:
    """既有时间又有地点的日程只走时间维度,不能同时被地理围栏命中——否则同一条日程
    会被两条链路各推一次提醒(time_triggered_at/geo_triggered_at 互不干涉)。"""
    start_time = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)
    session.add(
        _make_schedule(
            id="schedule_time_and_location",
            schedule_type="time",  # 同时填时间和地点时,业务层要求 schedule_type 为 time
            start_time=start_time.isoformat(),
            latitude=31.2451,
            longitude=121.5067,
        )
    )
    session.commit()

    adapter = SqlAlchemyScheduleDispatchAdapter(session)

    time_hits = TimeWindowTriggerService(adapter).find_schedules_entering_window(now=start_time)
    geo_hits = GeofenceTriggerService(adapter).find_geofence_transitions(
        "default_user", 31.2451, 121.5067
    )

    assert [schedule.id for schedule in time_hits] == ["schedule_time_and_location"]
    assert geo_hits == []


def test_set_geofence_armed_writes_flag(session: Session) -> None:
    session.add(_make_location_schedule(id="schedule_1", geofence_armed=0))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)

    adapter.set_geofence_armed("schedule_1", True)
    session.commit()

    assert _reload(session, "schedule_1").geofence_armed == 1


def test_mark_geo_triggered_writes_geo_triggered_at(session: Session) -> None:
    """第一次调用写入 ISO 格式的触发时间,并返回 True。"""
    session.add(_make_location_schedule(id="schedule_1"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    triggered_at = datetime(2026, 7, 29, 14, 45, tzinfo=UTC)

    wrote = adapter.mark_geo_triggered("schedule_1", triggered_at)
    session.commit()

    assert wrote is True
    assert _reload(session, "schedule_1").geo_triggered_at == triggered_at.isoformat()


def test_mark_geo_triggered_is_idempotent(session: Session) -> None:
    """已经写过 geo_triggered_at 的日程,再次调用不会覆盖,返回 False。"""
    session.add(_make_location_schedule(id="schedule_2"))
    session.commit()
    adapter = SqlAlchemyScheduleDispatchAdapter(session)
    first_triggered_at = datetime(2026, 7, 29, 14, 45, tzinfo=UTC)
    second_triggered_at = datetime(2026, 7, 29, 15, 0, tzinfo=UTC)

    adapter.mark_geo_triggered("schedule_2", first_triggered_at)
    session.commit()
    wrote_again = adapter.mark_geo_triggered("schedule_2", second_triggered_at)
    session.commit()

    assert wrote_again is False
    assert _reload(session, "schedule_2").geo_triggered_at == first_triggered_at.isoformat()
