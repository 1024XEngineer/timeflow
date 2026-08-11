"""Ports the WebSocket transport depends on, plus the contexts it passes through them."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class SessionContext:
    """An authenticated WebSocket session."""

    session_id: str
    account_id: str
    device_id: str


@dataclass(frozen=True, slots=True)
class AudioConfig:
    """Wire format of an inbound audio stream."""

    audio_format: str
    sample_rate_hz: int
    channels: int


@dataclass(frozen=True, slots=True)
class StreamContext:
    """A single inbound audio stream within a session."""

    stream_id: str
    conversation_id: str
    session: SessionContext
    audio_config: AudioConfig
    request_id: str | None = None


class TokenVerifier(Protocol):
    """Verify an access token and resolve the owning account.

    Failure is a return value rather than an exception: an exception type would have to be
    shared with every implementation, which defeats structural typing across the boundary.
    """

    async def verify(self, access_token: str) -> str | None:
        """Return the account id for a valid token, or None when it is not usable."""
        ...


class AudioSink(Protocol):
    """Consume one inbound audio stream to completion."""

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        """Drain the chunk stream; returning means this stream is finished."""
        ...
