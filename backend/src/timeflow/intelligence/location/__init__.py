"""Provider-neutral location data processing for Agent tools."""

from timeflow.intelligence.location.contracts import (
    ClientLocation,
    Coordinate,
    CoordinateSystem,
    CurrentArea,
    LocationCandidate,
    LocationConfigurationError,
    LocationConnectionError,
    LocationError,
    LocationInputError,
    LocationPort,
    LocationProtocolError,
    LocationSearchContext,
    ProviderLocationCandidate,
)
from timeflow.intelligence.location.coordinates import convert_coordinate
from timeflow.intelligence.location.service import (
    LocationSearchService,
    build_agent_location_context,
)
from timeflow.intelligence.location.tools import (
    LOCATION_SEARCH,
    PROVIDER_UNAVAILABLE_RESULT,
    LocationSearchTool,
    build_location_search_tool,
    build_unavailable_location_search_tool,
    location_search_definition,
)

__all__ = [
    "ClientLocation",
    "Coordinate",
    "CoordinateSystem",
    "CurrentArea",
    "LOCATION_SEARCH",
    "LocationCandidate",
    "LocationConfigurationError",
    "LocationConnectionError",
    "LocationError",
    "LocationInputError",
    "LocationPort",
    "LocationProtocolError",
    "LocationSearchContext",
    "LocationSearchService",
    "LocationSearchTool",
    "PROVIDER_UNAVAILABLE_RESULT",
    "ProviderLocationCandidate",
    "build_agent_location_context",
    "build_location_search_tool",
    "build_unavailable_location_search_tool",
    "convert_coordinate",
    "location_search_definition",
]
