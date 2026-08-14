"""Ports the WebSocket transport depends on, plus the contexts it passes through them."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True, slots=True)
class SessionContext:
    """An authenticated WebSocket session."""

    session_id: str
    account_id: str
    device_id: str
    latitude: float | None = None
    longitude: float | None = None
    coordinate_system: Literal["WGS84"] | None = None
    # Resolved at handshake time: the client's IANA zone when it sent a valid one,
    # the deployment default otherwise. Never left unset.
    timezone: str = "Asia/Shanghai"
    # Resolved at handshake time the same way: push_to_talk or continuous, never unset.
    voice_mode: str = "push_to_talk"


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

    @property
    def timezone(self) -> str:
        """IANA zone resolved for this session."""
        return self.session.timezone

    @property
    def voice_mode(self) -> str:
        """Voice interaction mode resolved for this session."""
        return self.session.voice_mode

    @property
    def latitude(self) -> float | None:
        """Client latitude reported at handshake, if any."""
        return self.session.latitude

    @property
    def longitude(self) -> float | None:
        """Client longitude reported at handshake, if any."""
        return self.session.longitude

    @property
    def coordinate_system(self) -> Literal["WGS84"] | None:
        """Reference system the client's coordinates are expressed in, if any."""
        return self.session.coordinate_system


class AudioSink(Protocol):
    """Consume one inbound audio stream to completion."""

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        """Drain the chunk stream; returning means this stream is finished."""
        ...
