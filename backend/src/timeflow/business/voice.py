"""Voice schedule use cases, ports, and shared DTOs."""

from __future__ import annotations

from collections.abc import AsyncIterable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

ScheduleType = Literal["time", "location"]


@dataclass(frozen=True, slots=True)
class SpeechRecognitionConfig:
    """Streaming ASR request settings."""

    audio_format: str = "pcm_s16le"
    sample_rate_hz: int = 16000
    channels: int = 1
    language: str | None = None


@dataclass(frozen=True, slots=True)
class SpeechRecognitionResult:
    """Final ASR output returned to the voice parsing flow."""

    text: str
    raw_events: tuple[dict[str, Any], ...] = ()
    request_id: str | None = None
    stream_id: str | None = None


@dataclass(frozen=True, slots=True)
class StructuredLLMResult:
    """Structured JSON returned by the model layer."""

    data: dict[str, Any]
    raw_text: str


@dataclass(frozen=True, slots=True)
class ScheduleDraft:
    """Frontend-confirmable schedule draft."""

    schedule_type: ScheduleType
    title: str
    notes: str | None
    start_time: str | None
    end_time: str | None
    timezone: str | None
    location_name: str | None
    location_address: str | None
    latitude: float | None
    longitude: float | None
    geofence_radius_meters: int
    time_remind_offset_minutes: int
    missing_fields: tuple[str, ...]
    ambiguous_fields: tuple[str, ...]
    needs_confirmation: bool

    def to_payload(self) -> dict[str, Any]:
        """Return the websocket-ready draft payload."""
        return {
            "schedule_type": self.schedule_type,
            "title": self.title,
            "notes": self.notes,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "timezone": self.timezone,
            "location_name": self.location_name,
            "location_address": self.location_address,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "geofence_radius_meters": self.geofence_radius_meters,
            "time_remind_offset_minutes": self.time_remind_offset_minutes,
            "missing_fields": list(self.missing_fields),
            "ambiguous_fields": list(self.ambiguous_fields),
            "needs_confirmation": self.needs_confirmation,
        }


@dataclass(frozen=True, slots=True)
class ScheduleParseResult:
    """Complete parser output."""

    draft: ScheduleDraft
    raw_model_text: str


@dataclass(frozen=True, slots=True)
class VoiceScheduleParseResult:
    """Result returned after audio transcription and schedule parsing."""

    speech: SpeechRecognitionResult
    parsed: ScheduleParseResult


class SpeechRecognitionPort(Protocol):
    """Streaming speech recognition capability used by the voice service."""

    async def recognize(
        self,
        audio_chunks: AsyncIterable[bytes],
        config: SpeechRecognitionConfig | None = None,
    ) -> SpeechRecognitionResult:
        """Transcribe streamed audio into text."""


class StructuredLLMPort(Protocol):
    """Structured JSON generation capability used by the parser."""

    async def generate_json(
        self,
        prompt: str,
        *,
        schema: dict[str, Any],
        response_name: str = "timeflow_response",
        system_prompt: str | None = None,
        temperature: float | None = None,
    ) -> StructuredLLMResult:
        """Generate structured JSON that matches the provided schema."""


class ScheduleDraftInterpreterPort(Protocol):
    """Parse ASR text into a schedule draft."""

    async def parse(self, asr_text: str) -> ScheduleParseResult:
        """Convert ASR text into a schedule draft result."""


class VoiceScheduleParsingService:
    """Compose ASR and schedule parsing into one use case."""

    def __init__(
        self,
        speech_client: SpeechRecognitionPort,
        draft_interpreter: ScheduleDraftInterpreterPort,
    ) -> None:
        self._speech_client = speech_client
        self._draft_interpreter = draft_interpreter

    async def parse_audio(
        self,
        audio_chunks: AsyncIterable[bytes],
        config: SpeechRecognitionConfig | None = None,
    ) -> VoiceScheduleParseResult:
        """Transcribe the audio stream and parse the resulting transcript."""
        speech = await self._speech_client.recognize(audio_chunks, config)
        parsed = await self._draft_interpreter.parse(speech.text)
        return VoiceScheduleParseResult(speech=speech, parsed=parsed)

    async def parse_text(self, asr_text: str) -> ScheduleParseResult:
        """Parse already recognized text without calling ASR again."""
        return await self._draft_interpreter.parse(asr_text)


__all__ = [
    "ScheduleDraft",
    "ScheduleDraftInterpreterPort",
    "ScheduleParseResult",
    "ScheduleType",
    "SpeechRecognitionConfig",
    "SpeechRecognitionPort",
    "SpeechRecognitionResult",
    "StructuredLLMPort",
    "StructuredLLMResult",
    "VoiceScheduleParseResult",
    "VoiceScheduleParsingService",
]
