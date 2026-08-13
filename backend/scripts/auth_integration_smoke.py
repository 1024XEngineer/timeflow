"""对真实 TimeFlow API 执行不泄露凭据的 HTTP/WebSocket 认证联调。"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from websockets.asyncio.client import connect

DEFAULT_HTTP_URL = "http://127.0.0.1:8000"
DEFAULT_WS_URL = "ws://127.0.0.1:8000/ws"
DEFAULT_WEB_ORIGIN = "http://localhost:8081"
REQUEST_TIMEOUT_SECONDS = 15


class SmokeCheckError(RuntimeError):
    """只携带固定检查描述，避免原始响应或凭据进入终端。"""


@dataclass(frozen=True, slots=True)
class AccessResult:
    """真实认证响应的最小安全视图；Token 不参与对象表示。"""

    account_id: str
    access_token: str = field(repr=False)


def _read_json(request: Request) -> tuple[int, Any]:
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:  # noqa: S310
        try:
            body = json.loads(response.read())
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise SmokeCheckError("HTTP response was not valid JSON") from error
        return response.status, body


def _check_health(http_url: str) -> None:
    status, body = _read_json(Request(f"{http_url}/api/v1/health"))
    if status != 200 or body != {"status": "ok"}:
        raise SmokeCheckError("health check did not return the expected contract")


def _check_cors(http_url: str, web_origin: str) -> None:
    request = Request(
        f"{http_url}/api/v1/auth/access",
        method="OPTIONS",
        headers={
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Method": "POST",
            "Origin": web_origin,
        },
    )
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:  # noqa: S310
        if (
            response.status != 200
            or response.headers.get("Access-Control-Allow-Origin") != web_origin
        ):
            raise SmokeCheckError("CORS preflight did not allow the configured Expo Web origin")


def _access(http_url: str, username: str, password: str) -> AccessResult:
    payload = json.dumps({"password": password, "username": username}).encode()
    request = Request(
        f"{http_url}/api/v1/auth/access",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    status, body = _read_json(request)
    if status != 200 or not isinstance(body, dict):
        raise SmokeCheckError("authentication request did not return a success response")
    if set(body) != {"account_id", "access_token", "expires_in"}:
        raise SmokeCheckError("authentication success response fields did not match the contract")

    account_id = body.get("account_id")
    access_token = body.get("access_token")
    if (
        not isinstance(account_id, str)
        or not account_id.strip()
        or not isinstance(access_token, str)
        or not access_token.strip()
        or body.get("expires_in") != 3600
    ):
        raise SmokeCheckError("authentication success response values did not match the contract")
    return AccessResult(account_id=account_id, access_token=access_token)


async def _check_websocket(ws_url: str, device_id: str, access_token: str) -> None:
    request_id = f"smoke-{uuid4().hex}"
    separator = "&" if "?" in ws_url else "?"
    url = f"{ws_url}{separator}{urlencode({'device_id': device_id})}"
    async with connect(url, open_timeout=REQUEST_TIMEOUT_SECONDS) as socket:
        await socket.send(
            json.dumps(
                {
                    "payload": {"access_token": access_token, "device_id": device_id},
                    "request_id": request_id,
                    "type": "session.hello",
                }
            )
        )
        raw_reply = await asyncio.wait_for(socket.recv(), REQUEST_TIMEOUT_SECONDS)

    if not isinstance(raw_reply, str):
        raise SmokeCheckError("WebSocket handshake did not return a text frame")
    try:
        reply = json.loads(raw_reply)
    except json.JSONDecodeError as error:
        raise SmokeCheckError("WebSocket handshake response was not valid JSON") from error
    if not isinstance(reply, dict) or (
        reply.get("type") != "session.ready"
        or reply.get("request_id") != request_id
        or reply.get("ok") is not True
    ):
        raise SmokeCheckError("WebSocket handshake did not return session.ready")
    payload = reply.get("payload")
    if not isinstance(payload, dict):
        raise SmokeCheckError("session.ready payload was missing")
    session_id = payload.get("session_id")
    server_time = payload.get("server_time")
    if not isinstance(session_id, str) or not session_id.strip():
        raise SmokeCheckError("session.ready session_id was invalid")
    if not isinstance(server_time, str):
        raise SmokeCheckError("session.ready server_time was invalid")
    try:
        parsed_time = datetime.fromisoformat(server_time.replace("Z", "+00:00"))
    except ValueError as error:
        raise SmokeCheckError("session.ready server_time was invalid") from error
    if parsed_time.utcoffset() is None:
        raise SmokeCheckError("session.ready server_time did not include a timezone")


async def _run() -> None:
    http_url = os.environ.get("TIMEFLOW_SMOKE_HTTP_URL", DEFAULT_HTTP_URL).rstrip("/")
    ws_url = os.environ.get("TIMEFLOW_SMOKE_WS_URL", DEFAULT_WS_URL)
    web_origin = os.environ.get("TIMEFLOW_SMOKE_WEB_ORIGIN", DEFAULT_WEB_ORIGIN).rstrip("/")
    suffix = uuid4().hex
    username = f"smoke_{suffix[:16]}"
    password = f"Smoke-{suffix}"
    device_id = f"smoke-device-{suffix[:16]}"

    _check_health(http_url)
    _check_cors(http_url, web_origin)
    created = _access(http_url, username, password)
    existing = _access(http_url, username, password)
    if existing.account_id != created.account_id:
        raise SmokeCheckError("existing account login returned a different account")
    await _check_websocket(ws_url, device_id, existing.access_token)


def main() -> int:
    try:
        asyncio.run(_run())
    except SmokeCheckError as error:
        print(f"Authentication integration smoke failed: {error}", file=sys.stderr)
        return 1
    except Exception:
        print(
            "Authentication integration smoke failed unexpectedly; inspect sanitized server logs.",
            file=sys.stderr,
        )
        return 1

    print("Authentication HTTP, CORS, existing-account login, and WebSocket checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
