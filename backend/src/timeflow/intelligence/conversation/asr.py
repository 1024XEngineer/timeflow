"""Provider-neutral ASR types for the intelligence layer."""

from __future__ import annotations

from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass
from typing import Protocol, TypeAlias


@dataclass(frozen=True, slots=True)
class TranscriptPreview:
    text: str


@dataclass(frozen=True, slots=True)
class TranscriptCompleted:
    text: str


AsrEvent: TypeAlias = TranscriptPreview | TranscriptCompleted


class AsrPort(Protocol):
    def stream(
        self,
        audio_chunks: AsyncIterable[bytes],
    ) -> AsyncIterator[AsrEvent]:
        """Stream provider-neutral ASR events for incoming audio."""


class AsrError(Exception):
    """Base class for provider-neutral ASR failures."""


class AsrConnectionError(AsrError):
    """The provider connection or lifecycle wait failed."""


class AsrProtocolError(AsrError):
    """The provider returned an invalid or rejected protocol message."""


class AsrTranscriptionError(AsrError):
    """The provider failed to transcribe an audio item."""
