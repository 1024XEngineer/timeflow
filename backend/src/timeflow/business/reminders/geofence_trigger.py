"""日程地理围栏提醒的判定逻辑。"""

import math
from collections.abc import Iterable
from enum import Enum
from typing import Protocol

from timeflow.business.schedules import ScheduleRecord

_EARTH_RADIUS_METERS = 6_371_000.0


class GeofenceQueryPort(Protocol):
    """business.reminders 对外声明的 Query Port,由 data 层实现。"""

    def list_geofence_schedules(self, user_id: str) -> Iterable[ScheduleRecord]:
        """返回该用户名下状态为 scheduled、绑定了经纬度且尚未触发过地理提醒的日程。"""
        ...


class GeofenceTransition(Enum):
    """一次位置上报相对某条日程围栏状态的变化。"""

    NO_CHANGE = "no_change"
    ARMED = "armed"
    TRIGGERED = "triggered"


def evaluate_geofence(schedule: ScheduleRecord, latitude: float, longitude: float) -> GeofenceTransition:
    """判定这次上报的位置相对该日程围栏的状态变化。

    `geofence_armed=False` 表示"当前在围栏内、还没离开过"(比如日程创建时人已经在围栏内);
    只有先侦测到离开(布防),之后再次进入才算命中,避免创建时立刻误触发。
    """
    is_inside = _distance_meters(schedule.latitude, schedule.longitude, latitude, longitude) <= (
        schedule.geofence_radius_meters
    )
    if schedule.geofence_armed:
        return GeofenceTransition.TRIGGERED if is_inside else GeofenceTransition.NO_CHANGE
    return GeofenceTransition.NO_CHANGE if is_inside else GeofenceTransition.ARMED


class GeofenceTriggerService:
    """判定一次位置上报命中了哪些日程的围栏变化。"""

    def __init__(self, query_port: GeofenceQueryPort) -> None:
        self._query_port = query_port

    def find_geofence_transitions(
        self, user_id: str, latitude: float, longitude: float
    ) -> list[tuple[ScheduleRecord, GeofenceTransition]]:
        """返回该用户名下所有发生了状态变化(非 NO_CHANGE)的日程及其变化类型。"""
        results: list[tuple[ScheduleRecord, GeofenceTransition]] = []
        for schedule in self._query_port.list_geofence_schedules(user_id):
            transition = evaluate_geofence(schedule, latitude, longitude)
            if transition is not GeofenceTransition.NO_CHANGE:
                results.append((schedule, transition))
        return results


def _distance_meters(lat1: float | None, lon1: float | None, lat2: float, lon2: float) -> float:
    """Haversine 公式计算两点间的球面距离(米)。"""
    if lat1 is None or lon1 is None:
        return math.inf
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    return 2 * _EARTH_RADIUS_METERS * math.asin(math.sqrt(a))
