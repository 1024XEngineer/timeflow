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
from timeflow.intelligence.location.references import is_personal_place_reference
from timeflow.intelligence.location.service import (
    LocationSearchService,
    build_agent_location_context,
)
from timeflow.intelligence.location.tools import (
    AMBIGUOUS_REFERENCE_RESULT,
    LOCATION_SEARCH,
    PROVIDER_UNAVAILABLE_RESULT,
    LocationSearchTool,
    build_lazy_location_search_tool,
    build_location_search_tool,
    build_unavailable_location_search_tool,
    location_search_definition,
)

__all__ = [
    "AMBIGUOUS_REFERENCE_RESULT",
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
    "build_lazy_location_search_tool",
    "build_location_search_tool",
    "build_unavailable_location_search_tool",
    "convert_coordinate",
    "is_personal_place_reference",
    "location_search_definition",
]
