"""The session.hello handshake that opens an authenticated session."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from timeflow.business.auth import AccessTokenService
from timeflow.gateway.websocket.envelope import (
    ERROR_MALFORMED_MESSAGE,
    ERROR_UNAUTHENTICATED,
    build_error_envelope,
)
from timeflow.gateway.websocket.messages.session import (
    SessionHello,
    SessionReady,
    SessionReadyPayload,
)
from timeflow.gateway.websocket.ports import SessionContext


@dataclass(frozen=True, slots=True)
class HandshakeResult:
    """Outcome of a handshake attempt: the reply, and the session when accepted."""

    reply: dict[str, Any]
    session: SessionContext | None


def new_session_id() -> str:
    """Return a fresh session identifier."""
    return f"ws_session_{uuid4().hex}"


class SessionHandshake:
    """Authenticate the opening frame of a connection."""

    def __init__(
        self,
        access_token_service: AccessTokenService,
        *,
        session_id_factory: Callable[[], str] | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        """保存令牌服务以及 ID、时间测试接缝。"""
        self._access_token_service = access_token_service
        self._session_id_factory = session_id_factory or new_session_id
        self._clock = clock or self._now

    def perform(
        self,
        raw_message: dict[str, Any],
        *,
        url_device_id: str | None = None,
    ) -> HandshakeResult:
        """校验首帧，并建立会话或返回拒绝结果。"""
        request_id = raw_message.get("request_id")
        if not isinstance(request_id, str):
            request_id = None

        if raw_message.get("type") != "session.hello":
            return self._rejected(
                request_id, ERROR_MALFORMED_MESSAGE, "The first message must be session.hello"
            )

        raw_payload = raw_message.get("payload")
        if isinstance(raw_payload, dict) and (
            "access_token" not in raw_payload or raw_payload.get("access_token") == ""
        ):
            return self._rejected(request_id, ERROR_UNAUTHENTICATED, "Access token is not valid")

        try:
            hello = SessionHello.model_validate(raw_message)
        except ValidationError:
            return self._rejected(
                request_id, ERROR_MALFORMED_MESSAGE, "session.hello payload is invalid"
            )

        if url_device_id is not None and hello.payload.device_id != url_device_id:
            return self._rejected(
                request_id,
                ERROR_MALFORMED_MESSAGE,
                "URL and session.hello device_id must match",
            )

        account_id = self._access_token_service.verify(hello.payload.access_token)
        if account_id is None:
            return self._rejected(request_id, ERROR_UNAUTHENTICATED, "Access token is not valid")

        session = SessionContext(
            session_id=self._session_id_factory(),
            account_id=account_id,
            device_id=hello.payload.device_id,
            latitude=hello.payload.latitude,
            longitude=hello.payload.longitude,
        )
        reply = SessionReady(
            request_id=hello.request_id,
            payload=SessionReadyPayload(
                session_id=session.session_id,
                server_time=self._clock().isoformat(),
            ),
        )
        return HandshakeResult(reply=reply.model_dump(), session=session)

    @staticmethod
    def _rejected(request_id: str | None, code: str, message: str) -> HandshakeResult:
        """Build a rejection carrying no session."""
        return HandshakeResult(
            reply=build_error_envelope("session.error", request_id, code, message),
            session=None,
        )

    @staticmethod
    def _now() -> datetime:
        """Return the current UTC time."""
        return datetime.now(UTC)
