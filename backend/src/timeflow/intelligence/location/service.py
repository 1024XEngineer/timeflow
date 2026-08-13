"""Prepare hidden location context and project provider search results."""

from __future__ import annotations

from timeflow.intelligence.location.contracts import (
    ClientLocation,
    CurrentArea,
    LocationCandidate,
    LocationInputError,
    LocationPort,
    LocationSearchContext,
)
from timeflow.intelligence.location.coordinates import convert_coordinate

_RESULT_LIMIT = 2


class LocationSearchService:
    """Coordinate reverse geocoding and POI search without Agent or transport concerns."""

    def __init__(self, location_port: LocationPort) -> None:
        self._location_port = location_port

    async def prepare(self, location: ClientLocation) -> LocationSearchContext:
        """Build the hidden Tencent search scope from a standard client position."""
        tencent_coordinate = convert_coordinate(location.coordinate, "gcj02")
        area = await self._location_port.reverse(tencent_coordinate)
        return LocationSearchContext(
            area=area,
            tencent_coordinate=tencent_coordinate,
            client_coordinate_system=location.coordinate.coordinate_system,
        )

    async def search(
        self,
        context: LocationSearchContext,
        query: str,
    ) -> tuple[LocationCandidate, ...]:
        """Search, project, and cap provider candidates in their original order."""
        keyword = _query(query)
        provider_candidates = await self._location_port.search(keyword, context)
        candidates: list[LocationCandidate] = []
        for item in provider_candidates:
            candidates.append(
                LocationCandidate(
                    provider_id=item.provider_id,
                    name=item.name,
                    address=item.address,
                    category=item.category,
                    coordinate=convert_coordinate(
                        item.coordinate,
                        context.client_coordinate_system,
                    ),
                    province=item.province,
                    city=item.city,
                    district=item.district,
                    distance_meters=item.distance_meters,
                )
            )
            if len(candidates) == _RESULT_LIMIT:
                break
        return tuple(candidates)


def build_agent_location_context(area: CurrentArea) -> str:
    """Return coarse location guidance that contains no precise client position."""
    return (
        f"用户当前所在区域：{area.province}，{area.city}。"
        "位置检索时只传入用户表达的目标地点，系统会自动使用当前区域；"
        "不得猜测或要求用户提供当前经纬度。"
    )


def _query(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LocationInputError("query must be a non-empty string")
    return value.strip()


__all__ = ["LocationSearchService", "build_agent_location_context"]
