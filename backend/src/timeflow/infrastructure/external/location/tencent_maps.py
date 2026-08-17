"""Tencent Maps WebService adapter for reverse geocoding and POI search."""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from typing import Any, TypeAlias
from urllib.parse import urlsplit

import httpx

from timeflow.intelligence.location.contracts import (
    Coordinate,
    CurrentArea,
    LocationConfigurationError,
    LocationConnectionError,
    LocationInputError,
    LocationProtocolError,
    LocationSearchContext,
    ProviderLocationCandidate,
)

logger = logging.getLogger(__name__)
# Tencent requires credentials and precise coordinates in query parameters. HTTPX's INFO
# request log includes the complete URL, so provider clients must never log below WARNING.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

_QueryValue: TypeAlias = str | int | float | bool | None


class TencentMapsLocationPort:
    """Adapt Tencent Maps responses into provider-neutral location values."""

    def __init__(self, client: httpx.AsyncClient, api_key: str, base_url: str) -> None:
        self._client = client
        self._api_key = api_key.strip()
        self._base_url = base_url.strip().rstrip("/")
        if not self._api_key:
            raise LocationConfigurationError("Tencent Maps is not configured")
        if not _valid_base_url(self._base_url):
            raise LocationConfigurationError("Tencent Maps base URL must be a HTTPS URL")

    async def reverse(self, coordinate: Coordinate) -> CurrentArea:
        """Resolve a Tencent-compatible coordinate into province and city."""
        if coordinate.coordinate_system != "gcj02":
            raise LocationInputError("Tencent reverse geocoding requires gcj02")
        payload = await self._get(
            "/ws/geocoder/v1/",
            {
                "key": self._api_key,
                "location": _coordinate_text(coordinate),
                "get_poi": 0,
                "output": "json",
            },
            operation="reverse",
        )
        result = _mapping(payload.get("result"), "reverse result")
        component = _mapping(result.get("address_component"), "address component")
        province = _required_text(component, "province")
        city = _required_text(component, "city")
        return CurrentArea(province, city)

    async def search(
        self,
        query: str,
        context: LocationSearchContext,
    ) -> tuple[ProviderLocationCandidate, ...]:
        """Search Tencent POIs in the system-provided city and current-position scope."""
        keyword = query
        coordinate = context.tencent_coordinate
        boundary = (
            f"region({context.area.city},0,{coordinate.latitude:.6f},{coordinate.longitude:.6f})"
        )
        payload = await self._get(
            "/ws/place/v1/search",
            {
                "key": self._api_key,
                "keyword": keyword,
                "boundary": boundary,
                "page_size": 5,
                "page_index": 1,
                "output": "json",
            },
            operation="search",
        )
        raw_data = payload.get("data", [])
        if not isinstance(raw_data, list):
            raise LocationProtocolError("Tencent Maps returned an invalid search result")
        candidates: list[ProviderLocationCandidate] = []
        for item in raw_data:
            candidate = _candidate(item)
            if candidate is not None:
                candidates.append(candidate)
        logger.info("Tencent Maps search succeeded: candidate_count=%s", len(candidates))
        return tuple(candidates)

    async def _get(
        self,
        path: str,
        params: Mapping[str, _QueryValue],
        *,
        operation: str,
    ) -> Mapping[str, Any]:
        try:
            response = await self._client.get(f"{self._base_url}{path}", params=params)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as error:
            logger.warning(
                "Tencent Maps request failed: operation=%s error_type=%s status_code=%s",
                operation,
                type(error).__name__,
                error.response.status_code,
            )
            raise LocationConnectionError("Tencent Maps request failed") from None
        except httpx.RequestError as error:
            logger.warning(
                "Tencent Maps request failed: operation=%s error_type=%s",
                operation,
                type(error).__name__,
            )
            raise LocationConnectionError("Tencent Maps request failed") from None
        except ValueError:
            logger.warning("Tencent Maps returned invalid JSON: operation=%s", operation)
            raise LocationProtocolError("Tencent Maps returned invalid JSON") from None
        if not isinstance(payload, dict):
            logger.warning("Tencent Maps returned invalid response: operation=%s", operation)
            raise LocationProtocolError("Tencent Maps returned an invalid response")
        status = payload.get("status")
        if isinstance(status, bool) or not isinstance(status, int) or status != 0:
            # Tencent's status/message say why (quota, auth, bad params, ...); neither
            # contains user data, so logging them is safe and is the only way to tell
            # these apart later -- LocationProtocolError itself carries no detail on.
            logger.warning(
                "Tencent Maps rejected the request: operation=%s status=%s message=%s",
                operation,
                status,
                payload.get("message"),
            )
            raise LocationProtocolError("Tencent Maps rejected the request")
        return payload


def _candidate(value: object) -> ProviderLocationCandidate | None:
    if not isinstance(value, dict):
        return None
    provider_id = _optional_text(value.get("id"))
    name = _optional_text(value.get("title"))
    location = value.get("location")
    if provider_id is None or name is None or not isinstance(location, dict):
        return None
    latitude = location.get("lat")
    longitude = location.get("lng")
    try:
        coordinate = Coordinate(latitude, longitude, "gcj02")  # type: ignore[arg-type]
    except LocationInputError:
        return None
    ad_info = value.get("ad_info")
    if not isinstance(ad_info, dict):
        ad_info = {}
    try:
        return ProviderLocationCandidate(
            provider_id=provider_id,
            name=name,
            address=_optional_text(value.get("address")) or "",
            category=_optional_text(value.get("category")) or "",
            coordinate=coordinate,
            province=_optional_text(ad_info.get("province")) or "",
            city=_optional_text(ad_info.get("city")) or "",
            district=_optional_text(ad_info.get("district")) or "",
            distance_meters=_distance(value.get("_distance")),
        )
    except LocationInputError:
        return None


def _mapping(value: object, field: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise LocationProtocolError(f"Tencent Maps returned an invalid {field}")
    return value


def _required_text(value: Mapping[str, Any], field: str) -> str:
    result = _optional_text(value.get(field))
    if result is None:
        raise LocationProtocolError(f"Tencent Maps response is missing {field}")
    return result


def _optional_text(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _distance(value: object) -> int | None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
        or value < 0
    ):
        return None
    return int(value)


def _valid_base_url(value: str) -> bool:
    parsed = urlsplit(value)
    return bool(
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
    )


def _coordinate_text(coordinate: Coordinate) -> str:
    return f"{coordinate.latitude:.6f},{coordinate.longitude:.6f}"


__all__ = ["TencentMapsLocationPort"]
