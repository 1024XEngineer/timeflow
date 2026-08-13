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
    # Accepted but not acted on yet -- no geocoding or geofencing consumes these.
    latitude: float | None = None
    longitude: float | None = None


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

    @property
    def account_id(self) -> str:
        """Account that owns this stream."""
        return self.session.account_id

    @property
    def session_id(self) -> str:
        """Session this stream belongs to."""
        return self.session.session_id


class AudioSink(Protocol):
    """Consume one inbound audio stream to completion."""

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        """Drain the chunk stream; returning means this stream is finished."""
        ...
