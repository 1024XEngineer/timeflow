"""Tencent Maps adapter tests without external network access."""

import asyncio
import json
import logging
from typing import Any

import httpx
import pytest

from timeflow.infrastructure.external.location import TencentMapsLocationPort
from timeflow.intelligence.location import (
    Coordinate,
    CurrentArea,
    LocationConfigurationError,
    LocationConnectionError,
    LocationInputError,
    LocationProtocolError,
    LocationSearchContext,
)

API_KEY = "unit-test-map-key"
BASE_URL = "https://maps.example.test"


def _port(handler: Any) -> TencentMapsLocationPort:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TencentMapsLocationPort(client, API_KEY, BASE_URL)


def _context() -> LocationSearchContext:
    return LocationSearchContext(
        CurrentArea("上海市", "上海市"),
        Coordinate(31.22846, 121.47822, "gcj02"),
        "wgs84",
    )


def _poi(
    *,
    provider_id: str = "poi-1",
    title: str = "上海虹桥站",
    latitude: object = 31.194,
    longitude: object = 121.318,
    province: object = "上海市",
    city: object = "上海市",
    distance: object = 1200.8,
) -> dict[str, object]:
    return {
        "id": provider_id,
        "title": title,
        "address": "申贵路1500号",
        "category": "火车站",
        "location": {"lat": latitude, "lng": longitude},
        "_distance": distance,
        "ad_info": {"province": province, "city": city, "district": "闵行区"},
    }


def test_reverse_sends_only_the_required_tencent_parameters() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/ws/geocoder/v1/"
            assert request.url.params["key"] == API_KEY
            assert request.url.params["location"] == "31.228460,121.478220"
            assert request.url.params["get_poi"] == "0"
            assert request.url.params["output"] == "json"
            return httpx.Response(
                200,
                json={
                    "status": 0,
                    "result": {
                        "address_component": {
                            "province": "上海市",
                            "city": "上海市",
                            "district": "闵行区",
                        }
                    },
                },
            )

        assert await _port(handler).reverse(
            Coordinate(31.22846, 121.47822, "gcj02")
        ) == CurrentArea("上海市", "上海市")

    asyncio.run(scenario())


def test_reverse_rejects_a_non_tencent_coordinate() -> None:
    async def scenario() -> None:
        with pytest.raises(LocationInputError, match="gcj02"):
            await _port(lambda _: httpx.Response(500)).reverse(Coordinate(31.23, 121.47, "wgs84"))

    asyncio.run(scenario())


@pytest.mark.parametrize("field", ["province", "city"])
def test_reverse_rejects_missing_required_area(field: str) -> None:
    async def scenario() -> None:
        component = {"province": "上海市", "city": "上海市"}
        component[field] = ""
        payload = {
            "status": 0,
            "result": {"address_component": component},
        }
        with pytest.raises(LocationProtocolError, match=field):
            await _port(lambda _: httpx.Response(200, json=payload)).reverse(
                Coordinate(31.23, 121.47, "gcj02")
            )

    asyncio.run(scenario())


def test_search_injects_city_and_hidden_coordinate_and_preserves_normalized_query() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/ws/place/v1/search"
            assert request.url.params["keyword"] == "虹桥火车站"
            assert request.url.params["boundary"] == "region(上海市,0,31.228460,121.478220)"
            assert request.url.params["page_size"] == "5"
            assert request.url.params["page_index"] == "1"
            return httpx.Response(200, json={"status": 0, "data": [_poi()]})

        (candidate,) = await _port(handler).search("虹桥火车站", _context())
        assert candidate.provider_id == "poi-1"
        assert candidate.coordinate == Coordinate(31.194, 121.318, "gcj02")
        assert candidate.distance_meters == 1200

    asyncio.run(scenario())


def test_search_skips_malformed_pois_and_accepts_empty_data() -> None:
    async def scenario() -> None:
        responses = iter(
            [
                {"status": 0, "data": [{"id": "missing-name"}, "not-an-object"]},
                {"status": 0},
            ]
        )

        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=next(responses))

        port = _port(handler)
        assert await port.search("虹桥", _context()) == ()
        assert await port.search("虹桥", _context()) == ()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "payload",
    [
        {"status": 1, "message": "bad key"},
        {"status": True},
        {"status": 0, "data": {}},
    ],
)
def test_provider_protocol_failures_are_sanitized(payload: dict[str, object]) -> None:
    async def scenario() -> None:
        port = _port(lambda _: httpx.Response(200, json=payload))
        with pytest.raises(LocationProtocolError) as caught:
            await port.search("虹桥", _context())
        assert API_KEY not in str(caught.value)
        assert "31.228" not in str(caught.value)

    asyncio.run(scenario())


def test_invalid_json_is_sanitized() -> None:
    async def scenario() -> None:
        with pytest.raises(LocationProtocolError, match="invalid JSON"):
            await _port(lambda _: httpx.Response(200, content=b"not-json")).search(
                "虹桥", _context()
            )

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "error", [httpx.TimeoutException("timeout"), httpx.RemoteProtocolError("bad protocol")]
)
def test_transport_failures_are_sanitized_and_clear_the_exception_cause(error: Exception) -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise error

        with pytest.raises(LocationConnectionError) as caught:
            await _port(handler).search("虹桥", _context())
        assert caught.value.__cause__ is None
        assert API_KEY not in str(caught.value)
        assert "31.228" not in str(caught.value)

    asyncio.run(scenario())


def test_http_status_failure_is_sanitized_and_clears_the_exception_cause() -> None:
    async def scenario() -> None:
        with pytest.raises(LocationConnectionError) as caught:
            await _port(lambda _: httpx.Response(503)).search("虹桥", _context())
        assert caught.value.__cause__ is None

    asyncio.run(scenario())


def test_network_failure_does_not_log_key_or_current_coordinate(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError(
                f"failed {request.url}?key={API_KEY}&location=31.228460,121.478220",
                request=request,
            )

        caplog.set_level(logging.INFO)
        with pytest.raises(LocationConnectionError):
            await _port(handler).search("虹桥", _context())
        visible = caplog.text
        assert API_KEY not in visible
        assert "31.228" not in visible
        assert "121.478" not in visible
        assert "?key=" not in visible

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("latitude", "longitude"),
    [(float("nan"), 121.318), (31.194, float("inf"))],
)
def test_search_skips_pois_with_non_finite_coordinates(latitude: object, longitude: object) -> None:
    response = {
        "status": 0,
        "data": [_poi(latitude=latitude, longitude=longitude)],
    }

    async def scenario() -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=json.dumps(response, allow_nan=True).encode(),
                headers={"content-type": "application/json"},
            )

        assert await _port(handler).search("虹桥", _context()) == ()

    asyncio.run(scenario())


@pytest.mark.parametrize("distance", [float("nan"), float("inf"), -1, "100", True])
def test_search_treats_invalid_distance_as_missing(distance: object) -> None:
    response = {"status": 0, "data": [_poi(distance=distance)]}

    async def scenario() -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=json.dumps(response, allow_nan=True).encode(),
                headers={"content-type": "application/json"},
            )

        (candidate,) = await _port(handler).search("虹桥", _context())
        assert candidate.distance_meters is None

    asyncio.run(scenario())


@pytest.mark.parametrize("field", ["province", "city"])
def test_search_skips_pois_missing_required_area(field: str) -> None:
    async def scenario() -> None:
        item = _poi()
        item["ad_info"] = {"province": "上海市", "city": "上海市"}
        item["ad_info"][field] = ""  # type: ignore[index]
        assert (
            await _port(lambda _: httpx.Response(200, json={"status": 0, "data": [item]})).search(
                "虹桥", _context()
            )
            == ()
        )

    asyncio.run(scenario())


def test_missing_configuration_is_rejected_without_exposing_a_secret() -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
    with pytest.raises(LocationConfigurationError, match="not configured"):
        TencentMapsLocationPort(client, "", BASE_URL)


def test_invalid_base_url_is_rejected() -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
    with pytest.raises(LocationConfigurationError, match="HTTPS"):
        TencentMapsLocationPort(client, API_KEY, "http://maps.example.test")


def test_search_error_does_not_expose_query_or_url() -> None:
    async def scenario() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.RequestError(f"failure at {request.url}", request=request)

        with pytest.raises(LocationConnectionError) as caught:
            await _port(handler).search("虹桥", _context())
        assert "虹桥" not in str(caught.value)
        assert "maps.example.test" not in str(caught.value)

    asyncio.run(scenario())
