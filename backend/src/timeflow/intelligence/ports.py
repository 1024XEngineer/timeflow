"""Ports the dialogue layer exposes, plus the values passed across them."""

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
class ReplyText:
    """The words of a reply as they become known, ahead of any audio for them.

    Carries what has been said so far rather than the newest fragment. A client that
    replaces its display cannot corrupt it by losing one of these or seeing two out of
    order, which a client that appends fragments can. A spoken reply is a sentence or two,
    so resending the whole of it costs little next to that.
    """

    reply_id: str
    speech_text: str
    done: bool = False


@dataclass(frozen=True, slots=True)
class DialogueQuestion:
    """One thing the user must supply before the turn can be acted on.

    Holds candidates as a tuple so a question cannot be passed around and then edited
    into having offered different choices than it did.
    """

    question_id: str
    question_kind: str
    speech_text: str
    required_response: str | None = None
    candidates: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True, slots=True)
class AudioReply:
    """What a spoken reply says and how it is encoded, sent ahead of the audio itself.

    Describes the audio without holding it; the bytes arrive separately as a stream.
    """

    audio_id: str
    audio_format: str
    sample_rate_hz: int
    purpose: str
    speech_text: str


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

    async def deliver_reply_text(self, reply: ReplyText, stream: StreamInfo) -> None:
        """Send the reply's words; call again as more of them are known.

        Separate from deliver_audio because the words are ready first. Announcing them on
        the audio's opening message would hold them until the first byte of speech exists,
        which for a synthesizer fed by a language model is well after the sentence is.
        """
        ...

    async def deliver_result(self, result: CommandResult, stream: StreamInfo) -> None:
        """Send the outcome of a command; call once it has actually been carried out."""
        ...

    async def deliver_question(self, question: DialogueQuestion, stream: StreamInfo) -> None:
        """Ask the user for one more thing, instead of acting on a guess.

        The question is spoken as well; this carries the structured form, so the client
        knows what kind of answer is expected and that one is expected at all.
        """
        ...

    async def deliver_audio(
        self, reply: AudioReply, chunks: AsyncIterator[bytes], stream: StreamInfo
    ) -> None:
        """Speak a reply, forwarding chunks as they are produced.

        Cancelling stops it early and still closes the run.
        """
        ...


class AgentPort(Protocol):
    """Take one audio stream and act on what it contains."""

    async def handle_audio(self, chunks: AsyncIterator[bytes], stream: StreamInfo) -> None:
        """Consume the audio; returning only confirms receipt, not a result.

        Results reach the client through ResultSink, not through this return value.
        """
        ...
