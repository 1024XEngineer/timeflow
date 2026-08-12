"""Provider-neutral speech synthesis contracts."""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias

SpeechPurpose: TypeAlias = Literal["dialogue_question", "command_result", "reminder"]


@dataclass(frozen=True, slots=True)
class SpeechSegment:
    """One ordered piece of text approved for speech synthesis."""

    index: int
    text: str
    purpose: SpeechPurpose


@dataclass(frozen=True, slots=True)
class TtsAudioChunk:
    """One provider-neutral block of synthesized audio."""

    data: bytes


@dataclass(frozen=True, slots=True)
class TtsCompleted:
    """The terminal event for one speech synthesis turn."""

    characters: int | None = None


TtsEvent: TypeAlias = TtsAudioChunk | TtsCompleted


class TtsPort(Protocol):
    """Synthesize one ordered stream of approved speech segments."""

    def stream(self, segments: AsyncIterable[SpeechSegment]) -> AsyncIterator[TtsEvent]:
        """Yield audio while text segments are still arriving."""
        ...


class TtsError(Exception):
    """Base class for provider-neutral speech synthesis failures."""


class TtsConnectionError(TtsError):
    """The speech synthesis provider could not be reached or timed out."""


class TtsProtocolError(TtsError):
    """The speech synthesis provider returned an invalid event sequence."""


class TtsSynthesisError(TtsError):
    """The provider rejected or failed the synthesis task."""
