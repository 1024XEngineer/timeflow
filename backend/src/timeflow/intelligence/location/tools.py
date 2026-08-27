"""The standalone location-search Function exposed for later Agent registration."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass

from timeflow.intelligence.conversation.llm import ToolDefinition
from timeflow.intelligence.location.contracts import (
    ClientLocation,
    LocationCandidate,
    LocationConfigurationError,
    LocationConnectionError,
    LocationError,
    LocationInputError,
    LocationProtocolError,
    LocationSearchContext,
)
from timeflow.intelligence.location.references import is_personal_place_reference
from timeflow.intelligence.location.service import LocationSearchService

LOCATION_SEARCH = "location_search"


@dataclass(frozen=True, slots=True)
class LocationSearchTool:
    """Execute one system-scoped POI search for an Agent."""

    definition: ToolDefinition
    service: LocationSearchService
    context: LocationSearchContext

    async def execute(self, arguments: Mapping[str, object]) -> str:
        """Validate the one Agent argument and return stable provider-neutral JSON."""
        if (reject := _reject_invalid_or_vague_query(arguments)) is not None:
            return reject
        try:
            candidates = await self.service.search(self.context, _query(arguments))
        except (LocationConfigurationError, LocationConnectionError, LocationProtocolError):
            return _json({"status": "provider_unavailable", "candidates": []})
        return _json(
            {
                "status": "ok",
                "candidates": [_candidate_json(candidate) for candidate in candidates],
            }
        )


def location_search_definition() -> ToolDefinition:
    """Return the only location Function definition available to an Agent."""
    return ToolDefinition(
        name=LOCATION_SEARCH,
        description=(
            "Search real points of interest for the target location expressed by the user. "
            "The system supplies the current area and search scope; never invent coordinates. "
            "For a location schedule, create it with the latitude and longitude of the "
            "returned candidate."
        ),
        parameters={
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
        },
    )


def build_location_search_tool(
    service: LocationSearchService,
    context: LocationSearchContext,
) -> LocationSearchTool:
    """Bind a prepared hidden location context to the standalone Function."""
    return LocationSearchTool(location_search_definition(), service, context)


def _query(arguments: Mapping[str, object]) -> str:
    unknown = set(arguments) - {"query"}
    if unknown:
        raise LocationInputError("location_search received unexpected fields")
    value = arguments.get("query")
    if not isinstance(value, str) or not value.strip():
        raise LocationInputError("query must be a non-empty string")
    return value.strip()


def _candidate_json(candidate: LocationCandidate) -> dict[str, object]:
    return {
        "provider_id": candidate.provider_id,
        "name": candidate.name,
        "address": candidate.address,
        "category": candidate.category,
        "latitude": candidate.coordinate.latitude,
        "longitude": candidate.coordinate.longitude,
        "coordinate_system": candidate.coordinate.coordinate_system,
        "province": candidate.province,
        "city": candidate.city,
        "district": candidate.district,
        "distance_meters": candidate.distance_meters,
    }


def _json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


# Shared across both Agents: whatever kept a real LocationSearchTool from being built at
# all -- no client location, no configured provider -- degrades to the exact same result
# LocationSearchTool.execute() itself returns for a live provider failure, so the model
# sees one error contract regardless of which layer decided location search was unavailable.
PROVIDER_UNAVAILABLE_RESULT = _json({"status": "provider_unavailable", "candidates": []})

# 模糊指代（「家」「公司」等）不是可检索地点：不返回候选，并明确引导模型向用户追问
# 具体地点/地址，而不是拿这个模糊词继续创建。
AMBIGUOUS_REFERENCE_RESULT = _json(
    {
        "status": "ambiguous_reference",
        "candidates": [],
        "hint": (
            "这是模糊指代，不是可检索的具体地点，无法返回候选；"
            "请调用 request_user_input 自然地问具体位置（如对「家」问「你家的地址是？」），"
            "不要生硬复述「具体是哪个家」这类说法。"
        ),
    }
)


def _reject_invalid_or_vague_query(arguments: Mapping[str, object]) -> str | None:
    """Return the short-circuit JSON for an invalid or vague query, else None.

    模糊指代必须在任何 provider 调用之前短路——包括懒加载路径的 prepare()/反向地理
    编码——这样模型对「家」「公司」永远看到稳定的 ambiguous_reference，而不是随
    provider 健康状态在 provider_unavailable 之间漂移。
    """
    try:
        query = _query(arguments)
    except LocationInputError:
        return _json({"status": "invalid_input", "candidates": []})
    if is_personal_place_reference(query):
        return AMBIGUOUS_REFERENCE_RESULT
    return None


@dataclass(frozen=True, slots=True)
class _UnavailableLocationSearchTool:
    """Stand in for LocationSearchTool when no location context could be prepared."""

    definition: ToolDefinition

    async def execute(self, arguments: Mapping[str, object]) -> str:
        """Ignore the query and report the provider as unavailable."""
        return PROVIDER_UNAVAILABLE_RESULT


def build_unavailable_location_search_tool() -> _UnavailableLocationSearchTool:
    """Return a location_search stand-in that always reports itself unavailable."""
    return _UnavailableLocationSearchTool(location_search_definition())


@dataclass(frozen=False, slots=True)
class _LazyLocationSearchTool:
    """Prepare the hidden search scope on first use and retry a failed prepare.

    Mirroring Realtime Agent's ToolBox._location_search: a provider that was briefly
    unreachable is retried on the next call rather than remembered, so an outage that
    opened mid-session does not disable location_search for the rest of the call once
    the provider recovers. Only a successful LocationSearchContext is cached.
    """

    definition: ToolDefinition
    service: LocationSearchService
    client_location: ClientLocation
    context: LocationSearchContext | None = None

    async def execute(self, arguments: Mapping[str, object]) -> str:
        if (reject := _reject_invalid_or_vague_query(arguments)) is not None:
            return reject
        if self.context is None:
            try:
                self.context = await self.service.prepare(self.client_location)
            except LocationError:
                return PROVIDER_UNAVAILABLE_RESULT
        return await build_location_search_tool(self.service, self.context).execute(arguments)


def build_lazy_location_search_tool(
    service: LocationSearchService,
    client_location: ClientLocation,
) -> _LazyLocationSearchTool:
    """Return a location_search tool that prepares its scope lazily, retrying failures."""
    return _LazyLocationSearchTool(location_search_definition(), service, client_location)


__all__ = [
    "AMBIGUOUS_REFERENCE_RESULT",
    "LOCATION_SEARCH",
    "PROVIDER_UNAVAILABLE_RESULT",
    "LocationSearchTool",
    "build_lazy_location_search_tool",
    "build_location_search_tool",
    "build_unavailable_location_search_tool",
    "location_search_definition",
]
