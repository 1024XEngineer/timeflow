"""What the transport needs from a dialogue agent, stated on the transport's own terms."""

from collections.abc import AsyncIterator
from typing import Any, Protocol


class StreamIdentity(Protocol):
    """Identifiers of the audio stream a result belongs to."""

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


class TranscriptResult(Protocol):
    """What the user was heard to say."""

    @property
    def text(self) -> str:
        """The transcribed words."""
        ...

    @property
    def language(self) -> str:
        """Language the words were recognized as."""
        ...

    @property
    def duration_ms(self) -> int:
        """How long the audio ran."""
        ...


class CommandOutcome(Protocol):
    """A command that was carried out, ready to be sent to the client."""

    @property
    def message_id(self) -> str:
        """Identifier the client echoes back in message.ack."""
        ...

    @property
    def operation(self) -> str:
        """Command that was carried out."""
        ...

    @property
    def status(self) -> str:
        """Outcome of that command."""
        ...

    @property
    def schedule(self) -> dict[str, Any]:
        """Persisted schedule snapshot the command produced."""
        ...


class AudioReplyInfo(Protocol):
    """Format and purpose of a spoken reply, announced before its audio."""

    @property
    def audio_id(self) -> str:
        """Identifier distinguishing this reply from the next."""
        ...

    @property
    def audio_format(self) -> str:
        """Encoding of the audio frames that follow."""
        ...

    @property
    def sample_rate_hz(self) -> int:
        """Sample rate the frames were produced at."""
        ...

    @property
    def purpose(self) -> str:
        """Why the reply is being spoken."""
        ...


class Agent(Protocol):
    """Take one audio stream and act on what it contains."""

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamIdentity) -> None:
        """Consume the audio; returning only confirms receipt, not a result."""
        ...
