"""Ports the dialogue layer exposes, plus the values passed across them.

The transport hands audio in through AgentPort and receives results back through
ResultSink. Both directions are one-way and asynchronous: handing audio over only
confirms receipt, and the semantic result arrives later through the other port.

These types stay free of any transport concern so the layer never imports the gateway.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol


class StreamInfo(Protocol):
    """Identifiers of the audio stream a result belongs to.

    Stated as a shape rather than a class because these values travel inward: the caller
    already holds them, so it supplies the object and this layer only reads it.
    """

    @property
    def session_id(self) -> str:
        """Session the stream belongs to."""
        ...

    @property
    def stream_id(self) -> str:
        """The stream itself."""
        ...

    @property
    def conversation_id(self) -> str:
        """Conversation the stream continues."""
        ...

    @property
    def request_id(self) -> str | None:
        """Request that opened the stream, when the client supplied one."""
        ...


@dataclass(frozen=True, slots=True)
class Transcript:
    """What the user was heard to say."""

    text: str
    language: str
    duration_ms: int


@dataclass(frozen=True, slots=True)
class AgentResult:
    """A completed turn: what was heard, and the command that was carried out.

    Carries every identifier the transport needs to address the result, so the
    receiving side translates and sends without inventing or looking up anything.
    """

    stream: StreamInfo
    message_id: str
    transcript: Transcript
    operation: str
    status: str
    schedule: dict[str, Any]


class ResultSink(Protocol):
    """Deliver a completed turn back to the client."""

    async def deliver(self, result: AgentResult) -> None:
        """Send the result; returning means it was handed to the transport."""
        ...


class AgentPort(Protocol):
    """Take one audio stream and act on what it contains."""

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Consume the audio; returning only confirms receipt, not a result.

        Results reach the client through ResultSink, not through this return value.
        """
        ...
