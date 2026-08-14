"""Ports the dialogue layer exposes, plus the values passed across them."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol


class StreamInfo(Protocol):
    """Identifiers of the audio stream a result belongs to."""

    @property
    def account_id(self) -> str:
        """Account that owns this stream."""
        ...

    @property
    def timezone(self) -> str:
        """IANA zone the session resolved, client-reported or the deployment default."""
        ...

    @property
    def voice_mode(self) -> str:
        """push_to_talk or continuous, resolved at handshake."""
        ...

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

    @property
    def latitude(self) -> float | None:
        """Client latitude reported at handshake, if any."""
        ...

    @property
    def longitude(self) -> float | None:
        """Client longitude reported at handshake, if any."""
        ...

    @property
    def coordinate_system(self) -> str | None:
        """Reference system the client's coordinates are expressed in, if any."""
        ...


@dataclass(frozen=True, slots=True)
class Transcript:
    """What the user was heard to say."""

    text: str
    language: str
    duration_ms: int


@dataclass(frozen=True, slots=True)
class ReplyText:
    """A reply's wording so far -- everything said, not the newest fragment."""

    reply_id: str
    speech_text: str
    done: bool = False


@dataclass(frozen=True, slots=True)
class DialogueQuestion:
    """One thing the user must supply before the turn can be acted on."""

    question_id: str
    question_kind: str
    speech_text: str
    required_response: str | None = None
    candidates: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True, slots=True)
class AudioReply:
    """What a spoken reply says and how it is encoded, sent ahead of the audio itself."""

    audio_id: str
    audio_format: str
    sample_rate_hz: int
    purpose: str
    speech_text: str


@dataclass(frozen=True, slots=True)
class CommandResult:
    """A command that was carried out, and the schedule state it left behind."""

    message_id: str
    operation: str
    status: str
    schedule: dict[str, Any] | None = None
    schedules: list[dict[str, Any]] | None = None


@dataclass(frozen=True, slots=True)
class AudioCanceled:
    """A spoken reply was interrupted before it finished; continuous mode only."""

    audio_id: str


class ResultSink(Protocol):
    """Push results back to the client, one method per protocol message."""

    async def deliver_transcript(self, transcript: Transcript, stream: StreamInfo) -> None:
        """Send what the user was heard to say; call as soon as it is known."""
        ...

    async def deliver_reply_text(self, reply: ReplyText, stream: StreamInfo) -> None:
        """Send the reply's words; call again as more of them are known."""
        ...

    async def deliver_result(self, result: CommandResult, stream: StreamInfo) -> None:
        """Send the outcome of a command; call once it has actually been carried out."""
        ...

    async def deliver_question(self, question: DialogueQuestion, stream: StreamInfo) -> None:
        """Ask the user for one more thing, instead of acting on a guess."""
        ...

    async def deliver_audio(
        self, reply: AudioReply, chunks: AsyncIterator[bytes], stream: StreamInfo
    ) -> None:
        """Speak a reply, forwarding chunks as they are produced."""
        ...

    async def deliver_canceled(self, canceled: AudioCanceled, stream: StreamInfo) -> None:
        """Tell the client a reply it may already be hearing was cut short."""
        ...

    async def deliver_session_end(self, stream: StreamInfo) -> None:
        """Tell the client this voice session should end now.

        No payload beyond the stream itself -- unlike the other deliver_* methods, there
        is nothing else to report.
        """
        ...


class AgentPort(Protocol):
    """Take one audio stream and act on what it contains."""

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Consume the audio; returning only confirms receipt, not a result."""
        ...
