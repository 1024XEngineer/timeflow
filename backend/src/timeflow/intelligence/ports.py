"""Ports the dialogue layer exposes, plus the values passed across them.

The transport hands audio in through AgentPort and pushes results back out through
ResultSink. Both directions are one-way and asynchronous: handing audio over only
confirms receipt, and results arrive later through the other port.

ResultSink has one method per protocol message rather than one method per turn. The two
messages become known at different moments -- the transcript as soon as the speech is
recognized, the command result only after the command has actually been carried out --
so bundling them would hold the transcript back until the slower half was ready.

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
class CommandResult:
    """A command that was carried out, and the schedule state it left behind.

    Holds no stream identifiers: the caller passes those separately, so the same result
    is never coupled to one particular stream.
    """

    message_id: str
    operation: str
    status: str
    schedule: dict[str, Any]


class ResultSink(Protocol):
    """Push results back to the client, one method per protocol message."""

    async def deliver_transcript(self, transcript: Transcript, stream: StreamInfo) -> None:
        """Send what the user was heard to say; call as soon as it is known."""
        ...

    async def deliver_result(self, result: CommandResult, stream: StreamInfo) -> None:
        """Send the outcome of a command; call once it has actually been carried out."""
        ...


class AgentPort(Protocol):
    """Take one audio stream and act on what it contains."""

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Consume the audio; returning only confirms receipt, not a result.

        Results reach the client through ResultSink, not through this return value.
        """
        ...
