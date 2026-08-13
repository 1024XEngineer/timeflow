"""Provider-neutral location contract tests."""

from dataclasses import FrozenInstanceError

import pytest

from timeflow.intelligence.location import (
    ClientLocation,
    Coordinate,
    CurrentArea,
    LocationCandidate,
    LocationInputError,
    LocationSearchContext,
    ProviderLocationCandidate,
)


def test_coordinate_normalizes_numbers_and_is_frozen() -> None:
    coordinate = Coordinate(31, 121, "wgs84")

    assert coordinate.latitude == 31.0
    assert coordinate.longitude == 121.0
    with pytest.raises(FrozenInstanceError):
        coordinate.latitude = 32  # type: ignore[misc]


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [
        (True, 121),
        (31, False),
        (float("nan"), 121),
        (31, float("inf")),
        (-91, 121),
        (31, 181),
    ],
)
def test_coordinate_rejects_invalid_numbers(latitude: object, longitude: object) -> None:
    with pytest.raises(LocationInputError):
        Coordinate(latitude, longitude, "wgs84")  # type: ignore[arg-type]


def test_coordinate_rejects_an_unknown_system() -> None:
    with pytest.raises(LocationInputError, match="coordinate_system"):
        Coordinate(31, 121, "bd09")  # type: ignore[arg-type]


def test_current_area_requires_both_coarse_fields() -> None:
    assert CurrentArea(" 上海市 ", "上海市") == CurrentArea("上海市", "上海市")
    with pytest.raises(LocationInputError, match="province"):
        CurrentArea(" ", "上海市")
    with pytest.raises(LocationInputError, match="city"):
        CurrentArea("上海市", "")


def test_search_context_requires_a_tencent_coordinate() -> None:
    with pytest.raises(LocationInputError, match="gcj02"):
        LocationSearchContext(
            CurrentArea("上海市", "上海市"), Coordinate(31, 121, "wgs84"), "wgs84"
        )


def test_provider_candidate_requires_identity_and_gcj02() -> None:
    valid_area = ("上海市", "上海市", "闵行区")
    with pytest.raises(LocationInputError, match="provider_id"):
        ProviderLocationCandidate("", "虹桥站", "", "", Coordinate(31, 121, "gcj02"), *valid_area)
    with pytest.raises(LocationInputError, match="gcj02"):
        ProviderLocationCandidate(
            "poi-1", "虹桥站", "", "", Coordinate(31, 121, "wgs84"), *valid_area
        )
    with pytest.raises(LocationInputError, match="distance"):
        ProviderLocationCandidate(
            "poi-1",
            "虹桥站",
            "",
            "",
            Coordinate(31, 121, "gcj02"),
            *valid_area,
            -1,
        )


def test_client_location_rejects_a_non_coordinate() -> None:
    with pytest.raises(LocationInputError, match="coordinate"):
        ClientLocation("not-a-coordinate")  # type: ignore[arg-type]


def test_candidates_require_coarse_area_and_integer_distance() -> None:
    coordinate = Coordinate(31, 121, "gcj02")
    with pytest.raises(LocationInputError, match="province"):
        ProviderLocationCandidate("poi-1", "虹桥站", "", "", coordinate, "", "上海市", "")
    with pytest.raises(LocationInputError, match="city"):
        ProviderLocationCandidate("poi-1", "虹桥站", "", "", coordinate, "上海市", "", "")

    for invalid in (True, 1.5, "1", -1):
        with pytest.raises(LocationInputError, match="distance"):
            LocationCandidate(
                "poi-1",
                "虹桥站",
                "",
                "",
                coordinate,
                "上海市",
                "上海市",
                "",
                invalid,  # type: ignore[arg-type]
            )
