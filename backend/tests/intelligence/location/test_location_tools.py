"""Standalone location-search Function tests."""

import asyncio
import json

import pytest

from timeflow.intelligence.location import (
    ClientLocation,
    Coordinate,
    CurrentArea,
    LocationConfigurationError,
    LocationConnectionError,
    LocationProtocolError,
    LocationSearchContext,
    ProviderLocationCandidate,
    build_lazy_location_search_tool,
    build_location_search_tool,
    location_search_definition,
)
from timeflow.intelligence.location.service import LocationSearchService


class SearchPort:
    """Return scripted provider candidates or a scripted expected failure."""

    def __init__(
        self,
        candidates: tuple[ProviderLocationCandidate, ...] = (),
        error: Exception | None = None,
    ) -> None:
        self.candidates = candidates
        self.error = error
        self.queries: list[str] = []

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        return CurrentArea("上海市", "上海市")

    async def search(
        self, query: str, context: LocationSearchContext
    ) -> tuple[ProviderLocationCandidate, ...]:
        self.queries.append(query)
        if self.error is not None:
            raise self.error
        return self.candidates


def _context() -> LocationSearchContext:
    return LocationSearchContext(
        CurrentArea("上海市", "上海市"),
        Coordinate(31.22846, 121.47822, "gcj02"),
        "gcj02",
    )


def _candidate(index: int) -> ProviderLocationCandidate:
    return ProviderLocationCandidate(
        f"poi-{index}",
        f"候选{index}",
        f"地址{index}",
        "地点",
        Coordinate(31 + index / 100, 121 + index / 100, "gcj02"),
        "上海市",
        "上海市",
        "闵行区",
        index * 100,
    )


def test_definition_exposes_only_one_query_argument() -> None:
    definition = location_search_definition()

    assert definition.name == "location_search"
    assert definition.parameters == {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "minLength": 1,
                "description": "The target place name or keyword expressed by the user.",
            }
        },
        "required": ["query"],
        "additionalProperties": False,
    }
    visible = json.dumps(definition.parameters)
    assert "latitude" not in visible
    assert "longitude" not in visible
    assert "city" not in visible
    assert "coordinate_system" not in visible


def test_tool_returns_at_most_two_client_compatible_candidates() -> None:
    async def scenario() -> None:
        port = SearchPort(tuple(_candidate(index) for index in range(1, 4)))
        tool = build_location_search_tool(LocationSearchService(port), _context())

        payload = json.loads(await tool.execute({"query": "  虹桥  "}))

        assert payload["status"] == "ok"
        assert [item["provider_id"] for item in payload["candidates"]] == ["poi-1", "poi-2"]
        assert payload["candidates"][0]["coordinate_system"] == "gcj02"
        assert port.queries == ["虹桥"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"query": ""},
        {"query": "   "},
        {"query": 7},
        {"query": "虹桥", "city": "北京"},
        {"query": "虹桥", "latitude": 31.2},
    ],
)
def test_tool_returns_stable_invalid_input(arguments: dict[str, object]) -> None:
    async def scenario() -> None:
        tool = build_location_search_tool(LocationSearchService(SearchPort()), _context())

        assert json.loads(await tool.execute(arguments)) == {
            "status": "invalid_input",
            "candidates": [],
        }

    asyncio.run(scenario())


def test_tool_sanitizes_provider_failure() -> None:
    async def scenario() -> None:
        tool = build_location_search_tool(
            LocationSearchService(SearchPort(error=LocationConnectionError("secret details"))),
            _context(),
        )

        result = await tool.execute({"query": "虹桥"})

        assert json.loads(result) == {"status": "provider_unavailable", "candidates": []}
        assert "secret" not in result

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "error",
    [
        LocationConfigurationError("missing map key"),
        LocationProtocolError("secret provider response"),
    ],
)
def test_tool_maps_configuration_and_protocol_failures(error: Exception) -> None:
    async def scenario() -> None:
        tool = build_location_search_tool(
            LocationSearchService(SearchPort(error=error)),
            _context(),
        )

        result = await tool.execute({"query": "虹桥"})

        assert json.loads(result) == {"status": "provider_unavailable", "candidates": []}
        assert "missing map key" not in result
        assert "secret provider response" not in result

    asyncio.run(scenario())


def test_tool_result_never_contains_the_hidden_current_coordinate() -> None:
    async def scenario() -> None:
        tool = build_location_search_tool(LocationSearchService(SearchPort()), _context())

        result = await tool.execute({"query": "虹桥"})

        assert "31.22846" not in result
        assert "121.47822" not in result

    asyncio.run(scenario())


class FlakyReversePort(SearchPort):
    """Fail the first reverse call, then succeed -- for retry-after-outage coverage."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.reverse_calls = 0

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        self.reverse_calls += 1
        if self.reverse_calls == 1:
            raise LocationConnectionError("provider briefly unreachable")
        return CurrentArea("上海市", "上海市")


def test_lazy_tool_retries_a_failed_prepare() -> None:
    """A prepare() failure is not cached, so the next call retries and succeeds."""

    async def scenario() -> None:
        port = FlakyReversePort(tuple(_candidate(index) for index in range(1, 2)))
        service = LocationSearchService(port)
        tool = build_lazy_location_search_tool(
            service, ClientLocation(Coordinate(31.22846, 121.47822, "wgs84"))
        )

        first = json.loads(await tool.execute({"query": "虹桥"}))
        second = json.loads(await tool.execute({"query": "虹桥"}))

        assert first == {"status": "provider_unavailable", "candidates": []}
        assert second["status"] == "ok"
        assert port.reverse_calls == 2

    asyncio.run(scenario())


def test_lazy_tool_caches_a_successful_prepare() -> None:
    """A successful prepare() is cached, so a later call does not re-prepare."""

    async def scenario() -> None:
        port = FlakyReversePort(tuple(_candidate(index) for index in range(1, 2)))
        port.reverse_calls = 1  # skip the scripted first-call failure: reverse succeeds now
        service = LocationSearchService(port)
        tool = build_lazy_location_search_tool(
            service, ClientLocation(Coordinate(31.22846, 121.47822, "wgs84"))
        )

        assert json.loads(await tool.execute({"query": "虹桥"}))["status"] == "ok"
        assert json.loads(await tool.execute({"query": "静安"}))["status"] == "ok"

        assert port.reverse_calls == 2

    asyncio.run(scenario())
