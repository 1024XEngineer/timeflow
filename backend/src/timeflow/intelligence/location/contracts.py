"""Provider-neutral values and ports for location processing."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Protocol

CoordinateSystem = Literal["wgs84", "gcj02"]
_SUPPORTED_COORDINATE_SYSTEMS = ("wgs84", "gcj02")


class LocationError(Exception):
    """Base class for expected location-processing failures."""


class LocationInputError(LocationError):
    """Location input cannot be processed safely."""


class LocationConfigurationError(LocationError):
    """The external location capability is not configured."""


class LocationConnectionError(LocationError):
    """The external location provider could not be reached."""


class LocationProtocolError(LocationError):
    """The external location provider returned an unusable response."""


@dataclass(frozen=True, slots=True)
class Coordinate:
    """A validated coordinate with an explicit reference system."""

    latitude: float
    longitude: float
    coordinate_system: CoordinateSystem

    def __post_init__(self) -> None:
        latitude = _coordinate_number(self.latitude, "latitude", -90, 90)
        longitude = _coordinate_number(self.longitude, "longitude", -180, 180)
        if self.coordinate_system not in _SUPPORTED_COORDINATE_SYSTEMS:
            raise LocationInputError("coordinate_system must be 'wgs84' or 'gcj02'")
        object.__setattr__(self, "latitude", latitude)
        object.__setattr__(self, "longitude", longitude)


@dataclass(frozen=True, slots=True)
class ClientLocation:
    """A standard client position supplied by the upstream session component."""

    coordinate: Coordinate

    def __post_init__(self) -> None:
        if not isinstance(self.coordinate, Coordinate):
            raise LocationInputError("coordinate must be a Coordinate")


@dataclass(frozen=True, slots=True)
class CurrentArea:
    """Province and city safe to expose as Agent context."""

    province: str
    city: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "province", _non_empty(self.province, "province"))
        object.__setattr__(self, "city", _non_empty(self.city, "city"))


@dataclass(frozen=True, slots=True)
class LocationSearchContext:
    """System-injected search scope hidden from Function arguments."""

    area: CurrentArea
    tencent_coordinate: Coordinate
    client_coordinate_system: CoordinateSystem

    def __post_init__(self) -> None:
        if self.tencent_coordinate.coordinate_system != "gcj02":
            raise LocationInputError("tencent_coordinate must use gcj02")
        if self.client_coordinate_system not in _SUPPORTED_COORDINATE_SYSTEMS:
            raise LocationInputError("client_coordinate_system must be 'wgs84' or 'gcj02'")


@dataclass(frozen=True, slots=True)
class ProviderLocationCandidate:
    """A location candidate as returned by an external provider."""

    provider_id: str
    name: str
    address: str
    category: str
    coordinate: Coordinate
    province: str
    city: str
    district: str
    distance_meters: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider_id", _non_empty(self.provider_id, "provider_id"))
        object.__setattr__(self, "name", _non_empty(self.name, "name"))
        object.__setattr__(self, "province", _non_empty(self.province, "province"))
        object.__setattr__(self, "city", _non_empty(self.city, "city"))
        if self.coordinate.coordinate_system != "gcj02":
            raise LocationInputError("provider candidate coordinate must use gcj02")
        _validate_distance(self.distance_meters)


@dataclass(frozen=True, slots=True)
class LocationCandidate:
    """A provider candidate projected into the client's coordinate system."""

    provider_id: str
    name: str
    address: str
    category: str
    coordinate: Coordinate
    province: str
    city: str
    district: str
    distance_meters: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider_id", _non_empty(self.provider_id, "provider_id"))
        object.__setattr__(self, "name", _non_empty(self.name, "name"))
        object.__setattr__(self, "province", _non_empty(self.province, "province"))
        object.__setattr__(self, "city", _non_empty(self.city, "city"))
        _validate_distance(self.distance_meters)


class LocationPort(Protocol):
    """Provider-neutral reverse-geocoding and POI-search capability."""

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        """Resolve a Tencent-compatible coordinate to province and city."""
        ...

    async def search(
        self,
        query: str,
        context: LocationSearchContext,
    ) -> tuple[ProviderLocationCandidate, ...]:
        """Search POIs using the system-injected current-area context."""
        ...


def _coordinate_number(value: object, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise LocationInputError(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise LocationInputError(f"{name} must be between {minimum} and {maximum}")
    return result


def _validate_distance(value: object) -> None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
        raise LocationInputError("distance_meters must be a non-negative integer or null")


def _non_empty(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LocationInputError(f"{name} must be a non-empty string")
    return value.strip()


__all__ = [
    "ClientLocation",
    "Coordinate",
    "CoordinateSystem",
    "CurrentArea",
    "LocationCandidate",
    "LocationConfigurationError",
    "LocationConnectionError",
    "LocationError",
    "LocationInputError",
    "LocationPort",
    "LocationProtocolError",
    "LocationSearchContext",
    "ProviderLocationCandidate",
]
