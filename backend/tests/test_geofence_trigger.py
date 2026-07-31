"""地理围栏触发判定的单元测试。"""

from collections.abc import Iterable

from timeflow.business.reminders.geofence_trigger import (
    GeofenceTransition,
    GeofenceTriggerService,
    evaluate_geofence,
)
from timeflow.business.schedules import ScheduleRecord

_COMPANY_LAT = 31.2451
_COMPANY_LON = 121.5067
_FAR_AWAY_LAT = 31.3451  # 距 _COMPANY_LAT 约 11 公里,明显在任何合理围栏之外
_FAR_AWAY_LON = 121.5067


class _StubQueryPort:
    def __init__(self, schedules: list[ScheduleRecord]) -> None:
        self._schedules = schedules

    def list_geofence_schedules(self, user_id: str) -> Iterable[ScheduleRecord]:
        del user_id
        return self._schedules


def _record(**overrides: object) -> ScheduleRecord:
    defaults: dict[str, object] = {
        "id": "schedule_1",
        "user_id": "user_1",
        "source_mode": "manual",
        "schedule_type": "location",
        "status": "scheduled",
        "title": "到公司打卡",
        "notes": None,
        "start_time": None,
        "end_time": None,
        "timezone": None,
        "location_name": "公司",
        "location_address": None,
        "latitude": _COMPANY_LAT,
        "longitude": _COMPANY_LON,
        "geofence_radius_meters": 100,
        "geofence_armed": True,
        "time_remind_offset_minutes": 15,
        "time_triggered_at": None,
        "geo_triggered_at": None,
        "system_schedule_ref_id": None,
        "system_alarm_ref_id": None,
        "created_at": "2026-07-28T12:00:00+00:00",
        "updated_at": "2026-07-28T12:00:00+00:00",
    }
    defaults.update(overrides)
    return ScheduleRecord(**defaults)  # type: ignore[arg-type]


def test_armed_and_inside_triggers() -> None:
    """已布防 + 命中进入围栏 → 触发。"""
    schedule = _record(geofence_armed=True)

    result = evaluate_geofence(schedule, _COMPANY_LAT, _COMPANY_LON)

    assert result is GeofenceTransition.TRIGGERED


def test_armed_and_outside_no_change() -> None:
    """已布防 + 还在围栏外 → 无变化,继续等待进入。"""
    schedule = _record(geofence_armed=True)

    result = evaluate_geofence(schedule, _FAR_AWAY_LAT, _FAR_AWAY_LON)

    assert result is GeofenceTransition.NO_CHANGE


def test_unarmed_and_outside_arms() -> None:
    """未布防(创建时在围栏内)+ 检测到已离开 → 布防,不触发。"""
    schedule = _record(geofence_armed=False)

    result = evaluate_geofence(schedule, _FAR_AWAY_LAT, _FAR_AWAY_LON)

    assert result is GeofenceTransition.ARMED


def test_unarmed_and_inside_no_change() -> None:
    """未布防 + 仍在围栏内(还没离开过)→ 无变化,不触发。"""
    schedule = _record(geofence_armed=False)

    result = evaluate_geofence(schedule, _COMPANY_LAT, _COMPANY_LON)

    assert result is GeofenceTransition.NO_CHANGE


def test_distance_exactly_at_radius_counts_as_inside() -> None:
    """距离正好等于围栏半径时算命中(边界含),用半径为 0、同一点验证。"""
    schedule = _record(geofence_armed=True, geofence_radius_meters=1)

    result = evaluate_geofence(schedule, _COMPANY_LAT, _COMPANY_LON)

    assert result is GeofenceTransition.TRIGGERED


def test_find_geofence_transitions_filters_out_no_change() -> None:
    """service 层只返回真正发生变化的日程,NO_CHANGE 的过滤掉。"""
    triggered_schedule = _record(id="schedule_triggered", geofence_armed=True)
    armed_schedule = _record(id="schedule_armed", geofence_armed=False)
    unchanged_schedule = _record(id="schedule_unchanged", geofence_armed=True)
    service = GeofenceTriggerService(
        _StubQueryPort([triggered_schedule, armed_schedule, unchanged_schedule])
    )

    result = service.find_geofence_transitions("user_1", _FAR_AWAY_LAT, _FAR_AWAY_LON)

    assert result == [(armed_schedule, GeofenceTransition.ARMED)]


def test_schedule_without_coordinates_never_counts_as_inside() -> None:
    """极端防御情况:即便查询端没按约定过滤掉没有经纬度的日程,判定这里也不应该误判命中。"""
    schedule = _record(latitude=None, longitude=None)

    result = evaluate_geofence(schedule, _COMPANY_LAT, _COMPANY_LON)

    assert result is GeofenceTransition.NO_CHANGE
