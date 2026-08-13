"""The standalone location-search Function exposed for later Agent registration."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass

from timeflow.intelligence.conversation.llm import ToolDefinition
from timeflow.intelligence.location.contracts import (
    LocationCandidate,
    LocationConfigurationError,
    LocationConnectionError,
    LocationInputError,
    LocationProtocolError,
    LocationSearchContext,
)
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
        try:
            query = _query(arguments)
            candidates = await self.service.search(self.context, query)
        except LocationInputError:
            return _json({"status": "invalid_input", "candidates": []})
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
            "The system supplies the current area and search scope; never invent coordinates."
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


__all__ = [
    "LOCATION_SEARCH",
    "LocationSearchTool",
    "build_location_search_tool",
    "location_search_definition",
]
