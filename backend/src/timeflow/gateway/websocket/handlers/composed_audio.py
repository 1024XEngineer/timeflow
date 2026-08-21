"""Gateway adapter dedicated to the composed voice backend."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from timeflow.gateway.websocket.ports import StreamContext


class AudioStreamInfo(Protocol):
    """Provider-neutral stream context required by the composed backend."""

    @property
    def session_id(self) -> str: ...

    @property
    def account_id(self) -> str: ...

    @property
    def timezone(self) -> str: ...

    @property
    def voice_mode(self) -> str: ...

    @property
    def latitude(self) -> float | None: ...

    @property
    def longitude(self) -> float | None: ...

    @property
    def coordinate_system(self) -> str | None: ...

    @property
    def stream_id(self) -> str: ...

    @property
    def conversation_id(self) -> str: ...

    @property
    def request_id(self) -> str | None: ...

    @property
    def audio_format(self) -> str: ...

    @property
    def sample_rate_hz(self) -> int: ...

    @property
    def channels(self) -> int: ...


@dataclass(frozen=True, slots=True)
class _ComposedAudioStream:
    session_id: str
    account_id: str
    timezone: str
    voice_mode: str
    latitude: float | None
    longitude: float | None
    coordinate_system: str | None
    stream_id: str
    conversation_id: str
    request_id: str | None
    audio_format: str
    sample_rate_hz: int
    channels: int


class ComposedAudioAgent(Protocol):
    """Composed backend capabilities required by this adapter."""

    async def handle_audio(
        self,
        chunks: AsyncIterator[bytes],
        stream: AudioStreamInfo,
    ) -> None: ...

    async def interrupt(self, session_id: str, reason: str) -> None: ...

    async def close_session(self, session_id: str) -> None: ...


class ComposedAgentAudioSink:
    """Translate Gateway stream context for the composed voice backend."""

    def __init__(self, agent: ComposedAudioAgent) -> None:
        self._agent = agent

    async def consume(self, chunks: AsyncIterator[bytes], stream: StreamContext) -> None:
        await self._agent.handle_audio(chunks, _stream_info(stream))

    async def interrupt(self, session_id: str, reason: str) -> None:
        await self._agent.interrupt(session_id, reason)

    async def close_session(self, session_id: str) -> None:
        await self._agent.close_session(session_id)


def _stream_info(stream: StreamContext) -> _ComposedAudioStream:
    return _ComposedAudioStream(
        session_id=stream.session.session_id,
        account_id=stream.session.account_id,
        timezone=stream.timezone,
        voice_mode=stream.voice_mode,
        latitude=stream.latitude,
        longitude=stream.longitude,
        coordinate_system=stream.coordinate_system,
        stream_id=stream.stream_id,
        conversation_id=stream.conversation_id,
        request_id=stream.request_id,
        audio_format=stream.audio_config.audio_format,
        sample_rate_hz=stream.audio_config.sample_rate_hz,
        channels=stream.audio_config.channels,
    )


__all__ = ["ComposedAgentAudioSink"]
