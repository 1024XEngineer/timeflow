"""Aliyun Qwen-ASR realtime gateway adapter."""

from __future__ import annotations

import asyncio
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

ASR_CLOSE_TIMEOUT_SECONDS = 0.1


class AliyunASRSettings(Protocol):
    """Shape required by the ASR client."""

    @property
    def ws_url(self) -> str: ...

    @property
    def api_key(self) -> str: ...

    @property
    def model(self) -> str: ...


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
            close_timeout=ASR_CLOSE_TIMEOUT_SECONDS,
        ) as websocket:
            await websocket.send(json.dumps(self._build_session_update_event(speech_config)))

            session_updated = asyncio.Event()
            sender = asyncio.create_task(
                self._send_audio(
                    websocket,
                    audio_chunks,
                    speech_config,
                    session_updated,
                )
            )
            receiver = asyncio.create_task(
                self._receive_result(
                    websocket,
                    collected_events,
                    session_updated,
                )
            )
            try:
                _, result = await asyncio.gather(sender, receiver)
            finally:
                for task in (sender, receiver):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(sender, receiver, return_exceptions=True)

        return result

    async def _send_audio(
        self,
        websocket: Any,
        audio_chunks: AsyncIterable[bytes],
        speech_config: SpeechRecognitionConfig,
        session_updated: asyncio.Event,
    ) -> None:
        """Forward chunks while the receive task consumes provider events."""
        try:
            await asyncio.wait_for(session_updated.wait(), timeout=10)
        except TimeoutError as exc:
            raise AliyunASRClientError("ASR session update timed out") from exc

        async for chunk in audio_chunks:
            await websocket.send(json.dumps(self._build_audio_append_event(chunk)))

        if speech_config.endpointing_mode == "manual":
            await websocket.send(json.dumps(self._build_commit_event()))
        await websocket.send(json.dumps(self._build_session_finish_event()))

    async def _receive_result(
        self,
        websocket: Any,
        collected_events: list[dict[str, Any]],
        session_updated: asyncio.Event,
    ) -> SpeechRecognitionResult:
        """Consume realtime provider events and combine all completed VAD segments."""
        completed_transcripts: list[str] = []
        latest_partial: str | None = None

        async for raw_message in websocket:
            event = self._parse_event(raw_message)
            collected_events.append(event)
            event_type = event.get("type")

            if event_type == "session.updated":
                session_updated.set()
                continue

            if event_type in {"error", "session.error"}:
                raise AliyunASRClientError(self._extract_error_message(event))

            if event_type == "conversation.item.input_audio_transcription.text":
                extracted = self._extract_text(event)
                latest_partial = extracted or latest_partial
                continue

            if event_type in {
                "conversation.item.input_audio_transcription.completed",
                "transcription.completed",
                "asr.completed",
            }:
                transcript = self._extract_text(event)
                if transcript:
                    completed_transcripts.append(transcript)
                    latest_partial = transcript
                continue

            if event_type == "session.finished":
                transcript = "".join(completed_transcripts).strip() or latest_partial
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
        transcription: dict[str, Any] = {}
        language = self._normalize_language(speech_config.language)
        if language is not None:
            transcription["language"] = language
        return {
            "event_id": self._next_event_id("session.update"),
            "type": "session.update",
            "session": {
                "modalities": ["text"],
                "input_audio_format": self._normalize_audio_format(speech_config.audio_format),
                "sample_rate": speech_config.sample_rate_hz,
                "input_audio_transcription": transcription,
                "turn_detection": self._build_turn_detection(speech_config),
            },
        }

    @staticmethod
    def _build_turn_detection(speech_config: SpeechRecognitionConfig) -> dict[str, Any] | None:
        if speech_config.endpointing_mode == "manual":
            return None
        return {
            "type": "server_vad",
            "threshold": speech_config.vad_threshold,
            "silence_duration_ms": speech_config.vad_silence_duration_ms,
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
            for key in ("message", "transcript", "text", "value", "content"):
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

    @classmethod
    def _extract_error_message(cls, event: dict[str, Any]) -> str:
        error = event.get("error")
        extracted = cls._extract_string(error)
        return extracted or "ASR provider returned an error"


__all__ = [
    "ASR_CLOSE_TIMEOUT_SECONDS",
    "AliyunASRClient",
    "AliyunASRClientError",
    "AliyunASRSettings",
]
