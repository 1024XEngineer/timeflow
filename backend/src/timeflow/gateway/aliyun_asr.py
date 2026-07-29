"""Aliyun Qwen-ASR realtime gateway adapter."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterable
from itertools import count
from typing import Any, Protocol, cast
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from websockets.asyncio.client import connect

from timeflow.business.voice import (
    SpeechRecognitionConfig,
    SpeechRecognitionPort,
    SpeechRecognitionResult,
)


class AliyunASRSettings(Protocol):
    """Shape required by the ASR client."""

    ws_url: str
    api_key: str
    model: str


class AliyunASRClientError(RuntimeError):
    """Raised when the ASR service returns no transcript."""


class AliyunASRClient(SpeechRecognitionPort):
    """Stream audio chunks to Aliyun and collect the final transcript."""

    def __init__(self, settings: AliyunASRSettings) -> None:
        self._settings = settings
        self._event_counter = count(1)

    async def recognize(
        self,
        audio_chunks: AsyncIterable[bytes],
        config: SpeechRecognitionConfig | None = None,
    ) -> SpeechRecognitionResult:
        """Transcribe streamed audio chunks into a final text result."""
        speech_config = config or SpeechRecognitionConfig()
        collected_events: list[dict[str, Any]] = []
        websocket_url = self._build_ws_url()

        async with connect(
            websocket_url,
            additional_headers=self._build_headers(),
            ping_interval=20,
            ping_timeout=20,
        ) as websocket:
            await websocket.send(json.dumps(self._build_session_update_event(speech_config)))

            async for chunk in audio_chunks:
                await websocket.send(json.dumps(self._build_audio_append_event(chunk)))

            await websocket.send(json.dumps(self._build_commit_event()))
            await websocket.send(json.dumps(self._build_session_finish_event()))

            transcript: str | None = None
            async for raw_message in websocket:
                event = self._parse_event(raw_message)
                collected_events.append(event)
                event_type = event.get("type")

                if event_type in {
                    "conversation.item.input_audio_transcription.text",
                    "conversation.item.input_audio_transcription.completed",
                    "transcription.completed",
                    "asr.completed",
                }:
                    transcript = self._extract_text(event) or transcript
                    if (
                        event_type
                        in {
                            "conversation.item.input_audio_transcription.completed",
                            "transcription.completed",
                            "asr.completed",
                        }
                        and transcript
                    ):
                        return SpeechRecognitionResult(
                            text=transcript,
                            raw_events=tuple(collected_events),
                        )
                    continue

                if event_type == "session.finished":
                    if transcript:
                        return SpeechRecognitionResult(
                            text=transcript,
                            raw_events=tuple(collected_events),
                        )
                    raise AliyunASRClientError("ASR session finished without a transcript")

        raise AliyunASRClientError("ASR stream ended without a transcript")

    def _build_headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._settings.api_key}",
            "X-TimeFlow-Provider": "aliyun-asr",
        }
        return headers

    def _build_ws_url(self) -> str:
        parsed = urlparse(self._settings.ws_url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["model"] = self._settings.model
        return urlunparse(parsed._replace(query=urlencode(query)))

    def _build_session_update_event(self, speech_config: SpeechRecognitionConfig) -> dict[str, Any]:
        return {
            "event_id": self._next_event_id("session.update"),
            "type": "session.update",
            "session": {
                "input_audio_format": self._normalize_audio_format(speech_config.audio_format),
                "sample_rate": speech_config.sample_rate_hz,
                "input_audio_transcription": {
                    "language": self._normalize_language(speech_config.language),
                },
                "turn_detection": None,
            },
        }

    def _build_audio_append_event(self, chunk: bytes) -> dict[str, Any]:
        return {
            "event_id": self._next_event_id("input_audio_buffer.append"),
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(chunk).decode("ascii"),
        }

    def _build_commit_event(self) -> dict[str, Any]:
        return {
            "event_id": self._next_event_id("input_audio_buffer.commit"),
            "type": "input_audio_buffer.commit",
        }

    def _build_session_finish_event(self) -> dict[str, Any]:
        return {
            "event_id": self._next_event_id("session.finish"),
            "type": "session.finish",
        }

    def _next_event_id(self, event_type: str) -> str:
        return f"{event_type}_{next(self._event_counter)}"

    @staticmethod
    def _normalize_audio_format(audio_format: str) -> str:
        if audio_format in {"pcm", "opus"}:
            return audio_format
        if audio_format == "pcm_s16le":
            return "pcm"
        return audio_format

    @staticmethod
    def _normalize_language(language: str | None) -> str | None:
        if language is None:
            return None
        normalized = language.strip().lower()
        if not normalized:
            return None
        if normalized in {"zh-cn", "zh-hans"}:
            return "zh"
        if normalized in {"en-us", "en-gb"}:
            return "en"
        if "-" in normalized:
            return normalized.split("-", 1)[0]
        return normalized

    @staticmethod
    def _parse_event(raw_message: Any) -> dict[str, Any]:
        if isinstance(raw_message, bytes):
            raw_message = raw_message.decode("utf-8")
        if isinstance(raw_message, str):
            return cast(dict[str, Any], json.loads(raw_message))
        if isinstance(raw_message, dict):
            return raw_message
        return {"type": "unknown", "raw": raw_message}

    @classmethod
    def _extract_text(cls, event: Any) -> str | None:
        if isinstance(event, str):
            return event.strip() or None
        if not isinstance(event, dict):
            return None

        for key in ("transcript", "text", "stash", "content"):
            value = event.get(key)
            extracted = cls._extract_string(value)
            if extracted:
                return extracted

        data = event.get("data")
        if isinstance(data, dict):
            extracted = cls._extract_text(data)
            if extracted:
                return extracted

        delta = event.get("delta")
        extracted = cls._extract_string(delta)
        if extracted:
            return extracted

        return None

    @classmethod
    def _extract_string(cls, value: Any) -> str | None:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        if isinstance(value, dict):
            for key in ("transcript", "text", "value", "content"):
                candidate = value.get(key)
                extracted = cls._extract_string(candidate)
                if extracted:
                    return extracted
            return None
        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                extracted = cls._extract_string(item)
                if extracted:
                    parts.append(extracted)
            combined = "".join(parts).strip()
            return combined or None
        return None

__all__ = ["AliyunASRClient", "AliyunASRClientError", "AliyunASRSettings"]
