"""Coordinate conversion tests."""

import pytest

from timeflow.intelligence.location import Coordinate, convert_coordinate


def test_wgs84_converts_to_known_shanghai_gcj02_point() -> None:
    converted = convert_coordinate(Coordinate(31.2304, 121.4737, "wgs84"), "gcj02")

    assert converted.coordinate_system == "gcj02"
    assert converted.latitude == pytest.approx(31.22846, abs=0.00002)
    assert converted.longitude == pytest.approx(121.47822, abs=0.00002)


def test_gcj02_round_trip_recovers_wgs84() -> None:
    original = Coordinate(31.2304, 121.4737, "wgs84")

    recovered = convert_coordinate(convert_coordinate(original, "gcj02"), "wgs84")

    assert recovered.latitude == pytest.approx(original.latitude, abs=0.000001)
    assert recovered.longitude == pytest.approx(original.longitude, abs=0.000001)


def test_same_coordinate_system_does_not_move_the_point() -> None:
    original = Coordinate(31.2304, 121.4737, "gcj02")

    assert convert_coordinate(original, "gcj02") is original


def test_a_point_outside_mainland_keeps_its_numbers() -> None:
    original = Coordinate(35.6812, 139.7671, "wgs84")

    converted = convert_coordinate(original, "gcj02")

    assert converted == Coordinate(35.6812, 139.7671, "gcj02")


def test_an_unknown_output_system_is_rejected() -> None:
    with pytest.raises(ValueError, match="output_system"):
        convert_coordinate(Coordinate(31, 121, "wgs84"), "bd09")  # type: ignore[arg-type]
