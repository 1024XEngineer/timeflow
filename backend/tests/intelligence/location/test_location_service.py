"""Location search processing tests."""

import asyncio

import pytest

from timeflow.intelligence.location import (
    ClientLocation,
    Coordinate,
    CurrentArea,
    LocationInputError,
    LocationSearchContext,
    LocationSearchService,
    ProviderLocationCandidate,
    build_agent_location_context,
)


class RecordingPort:
    """Record reverse and search calls while returning scripted provider values."""

    def __init__(self, candidates: tuple[ProviderLocationCandidate, ...] = ()) -> None:
        self.candidates = candidates
        self.reversed: list[Coordinate] = []
        self.searches: list[tuple[str, LocationSearchContext]] = []

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        self.reversed.append(coordinate)
        return CurrentArea("上海市", "上海市")

    async def search(
        self, query: str, context: LocationSearchContext
    ) -> tuple[ProviderLocationCandidate, ...]:
        self.searches.append((query, context))
        return self.candidates


def _provider_candidate(index: int) -> ProviderLocationCandidate:
    return ProviderLocationCandidate(
        provider_id=f"poi-{index}",
        name=f"候选{index}",
        address=f"地址{index}",
        category="地点",
        coordinate=Coordinate(31.194 + index / 1000, 121.318 + index / 1000, "gcj02"),
        province="上海市",
        city="上海市",
        district="闵行区",
        distance_meters=index * 100,
    )


def test_prepare_converts_wgs84_before_reverse_geocoding() -> None:
    async def scenario() -> None:
        port = RecordingPort()
        context = await LocationSearchService(port).prepare(
            ClientLocation(Coordinate(31.2304, 121.4737, "wgs84"))
        )

        assert context.area == CurrentArea("上海市", "上海市")
        assert context.client_coordinate_system == "wgs84"
        assert port.reversed == [context.tencent_coordinate]
        assert context.tencent_coordinate.coordinate_system == "gcj02"
        assert context.tencent_coordinate.latitude == pytest.approx(31.22846, abs=0.00002)

    asyncio.run(scenario())


def test_prepare_does_not_move_an_existing_gcj02_position() -> None:
    async def scenario() -> None:
        coordinate = Coordinate(31.22846, 121.47822, "gcj02")
        port = RecordingPort()

        context = await LocationSearchService(port).prepare(ClientLocation(coordinate))

        assert context.tencent_coordinate is coordinate
        assert context.client_coordinate_system == "gcj02"

    asyncio.run(scenario())


def test_search_projects_to_client_system_and_keeps_provider_order() -> None:
    async def scenario() -> None:
        port = RecordingPort(tuple(_provider_candidate(index) for index in range(1, 4)))
        service = LocationSearchService(port)
        context = LocationSearchContext(
            CurrentArea("上海市", "上海市"),
            Coordinate(31.22846, 121.47822, "gcj02"),
            "wgs84",
        )

        candidates = await service.search(context, "  虹桥  ")

        assert [candidate.provider_id for candidate in candidates] == ["poi-1", "poi-2"]
        assert all(candidate.coordinate.coordinate_system == "wgs84" for candidate in candidates)
        assert port.searches == [("虹桥", context)]

    asyncio.run(scenario())


def test_gcj02_client_receives_the_provider_coordinates_unchanged() -> None:
    async def scenario() -> None:
        item = _provider_candidate(1)
        port = RecordingPort((item,))
        context = LocationSearchContext(
            CurrentArea("上海市", "上海市"),
            Coordinate(31.22846, 121.47822, "gcj02"),
            "gcj02",
        )

        (candidate,) = await LocationSearchService(port).search(context, "虹桥")

        assert candidate.coordinate is item.coordinate

    asyncio.run(scenario())


@pytest.mark.parametrize("query", ["", "   ", 7, None])
def test_search_rejects_an_invalid_query(query: object) -> None:
    async def scenario() -> None:
        context = LocationSearchContext(
            CurrentArea("上海市", "上海市"),
            Coordinate(31.22846, 121.47822, "gcj02"),
            "gcj02",
        )
        with pytest.raises(LocationInputError, match="query"):
            await LocationSearchService(RecordingPort()).search(context, query)  # type: ignore[arg-type]

    asyncio.run(scenario())


def test_agent_context_contains_only_coarse_location() -> None:
    text = build_agent_location_context(CurrentArea("上海市", "上海市"))

    assert "上海市" in text
    assert "经纬度" in text
    assert "31." not in text
    assert "121." not in text
    assert "gcj02" not in text
