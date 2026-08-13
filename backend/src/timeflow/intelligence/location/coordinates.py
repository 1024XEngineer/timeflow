"""Explicit WGS84 and GCJ-02 coordinate conversions."""

import math

from timeflow.intelligence.location.contracts import Coordinate, CoordinateSystem

_EARTH_RADIUS = 6_378_245.0
_ECCENTRICITY_SQUARED = 0.00669342162296594323


def convert_coordinate(
    coordinate: Coordinate,
    output_system: CoordinateSystem,
) -> Coordinate:
    """Convert a labeled coordinate without ever guessing its source system."""
    if output_system not in ("wgs84", "gcj02"):
        raise ValueError("output_system must be 'wgs84' or 'gcj02'")
    if coordinate.coordinate_system == output_system:
        return coordinate
    if coordinate.coordinate_system == "wgs84":
        latitude, longitude = _wgs84_to_gcj02(coordinate.latitude, coordinate.longitude)
    else:
        latitude, longitude = _gcj02_to_wgs84(coordinate.latitude, coordinate.longitude)
    return Coordinate(latitude, longitude, output_system)


def _outside_mainland(latitude: float, longitude: float) -> bool:
    return not (73.66 < longitude < 135.05 and 3.86 < latitude < 53.55)


def _wgs84_to_gcj02(latitude: float, longitude: float) -> tuple[float, float]:
    if _outside_mainland(latitude, longitude):
        return latitude, longitude
    delta_latitude, delta_longitude = _offset(latitude, longitude)
    return latitude + delta_latitude, longitude + delta_longitude


def _gcj02_to_wgs84(latitude: float, longitude: float) -> tuple[float, float]:
    if _outside_mainland(latitude, longitude):
        return latitude, longitude
    # Iteration is still a pure deterministic conversion and is substantially more accurate
    # than subtracting a single forward offset near the edges of the transformed region.
    wgs_latitude = latitude
    wgs_longitude = longitude
    for _ in range(3):
        converted_latitude, converted_longitude = _wgs84_to_gcj02(
            wgs_latitude, wgs_longitude
        )
        wgs_latitude -= converted_latitude - latitude
        wgs_longitude -= converted_longitude - longitude
    return wgs_latitude, wgs_longitude


def _offset(latitude: float, longitude: float) -> tuple[float, float]:
    x = longitude - 105.0
    y = latitude - 35.0
    latitude_delta = _transform_latitude(x, y)
    longitude_delta = _transform_longitude(x, y)
    radians = latitude / 180.0 * math.pi
    magic = 1 - _ECCENTRICITY_SQUARED * math.sin(radians) ** 2
    root = math.sqrt(magic)
    latitude_delta = (
        latitude_delta
        * 180.0
        / ((_EARTH_RADIUS * (1 - _ECCENTRICITY_SQUARED)) / (magic * root) * math.pi)
    )
    longitude_delta = (
        longitude_delta
        * 180.0
        / (_EARTH_RADIUS / root * math.cos(radians) * math.pi)
    )
    return latitude_delta, longitude_delta


def _transform_latitude(x: float, y: float) -> float:
    result = (
        -100.0
        + 2.0 * x
        + 3.0 * y
        + 0.2 * y * y
        + 0.1 * x * y
        + 0.2 * math.sqrt(abs(x))
    )
    result += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    result += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    result += (
        160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)
    ) * 2.0 / 3.0
    return result


def _transform_longitude(x: float, y: float) -> float:
    result = (
        300.0
        + x
        + 2.0 * y
        + 0.1 * x * x
        + 0.1 * x * y
        + 0.1 * math.sqrt(abs(x))
    )
    result += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    result += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    result += (
        150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)
    ) * 2.0 / 3.0
    return result


__all__ = ["convert_coordinate"]
