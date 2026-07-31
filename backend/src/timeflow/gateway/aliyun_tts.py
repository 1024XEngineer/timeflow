"""Aliyun Qwen-Audio-TTS HTTP gateway adapter."""

from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

from timeflow.business.reminders import ReminderAudio, TextToSpeechPort


class AliyunTTSSettings(Protocol):
    """Shape required by the Aliyun TTS client."""

    @property
    def api_url(self) -> str: ...

    @property
    def api_key(self) -> str: ...

    @property
    def model(self) -> str: ...

    @property
    def voice(self) -> str: ...

    @property
    def audio_format(self) -> str: ...

    @property
    def sample_rate_hz(self) -> int: ...

    @property
    def timeout_seconds(self) -> float: ...


class AliyunTTSClientError(RuntimeError):
    """Raised when Aliyun cannot produce or return an audio file."""


class AliyunTTSClient(TextToSpeechPort):
    """Call Qwen-Audio-TTS HTTP API and download its temporary audio URL."""

    def __init__(
        self,
        settings: AliyunTTSSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    async def synthesize(self, text: str) -> ReminderAudio:
        """Synthesize complete audio bytes from reminder text."""
        normalized_text = text.strip()
        if not normalized_text:
            raise AliyunTTSClientError("TTS text must not be empty")
        if not self._settings.api_key.strip():
            raise AliyunTTSClientError("Aliyun TTS API key is not configured")
        if "{WorkspaceId}" in self._settings.api_url:
            raise AliyunTTSClientError(
                "Aliyun TTS API URL still contains the {WorkspaceId} placeholder"
            )

        response = await self._get_client().post(
            self._settings.api_url,
            headers={"Authorization": f"Bearer {self._settings.api_key}"},
            json={
                "model": self._settings.model,
                "input": {
                    "text": normalized_text,
                    "voice": self._settings.voice,
                    "format": self._settings.audio_format,
                    "sample_rate": self._settings.sample_rate_hz,
                },
            },
        )
        payload = self._decode_response(response, "TTS synthesis request failed")
        audio_url = self._extract_audio_url(payload)
        self._validate_audio_url(audio_url)

        audio_response = await self._get_client().get(audio_url)
        if audio_response.is_error:
            raise AliyunTTSClientError(
                f"TTS audio download failed with HTTP {audio_response.status_code}"
            )
        audio_data = audio_response.content
        if not audio_data:
            raise AliyunTTSClientError("TTS audio download returned empty content")

        return ReminderAudio(
            data=audio_data,
            audio_format=self._audio_format(
                audio_response.headers.get("content-type"),
                self._settings.audio_format,
            ),
        )

    async def aclose(self) -> None:
        """Release the underlying HTTP client."""
        if self._client is None:
            return
        await self._client.aclose()
        self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self._settings.timeout_seconds,
                transport=self._transport,
                follow_redirects=True,
            )
        return self._client

    @staticmethod
    def _decode_response(response: httpx.Response, message: str) -> dict[str, Any]:
        if response.is_error:
            detail = response.text[:500]
            raise AliyunTTSClientError(f"{message}: HTTP {response.status_code}: {detail}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise AliyunTTSClientError(f"{message}: invalid JSON response") from exc
        if not isinstance(payload, dict):
            raise AliyunTTSClientError(f"{message}: response must be an object")
        return payload

    @staticmethod
    def _extract_audio_url(payload: dict[str, Any]) -> str:
        output = payload.get("output")
        audio = output.get("audio") if isinstance(output, dict) else None
        url = audio.get("url") if isinstance(audio, dict) else None
        if not isinstance(url, str) or not url.strip():
            raise AliyunTTSClientError("TTS response does not contain output.audio.url")
        return url

    @staticmethod
    def _validate_audio_url(audio_url: str) -> None:
        parsed = urlparse(audio_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise AliyunTTSClientError("TTS response returned an invalid audio URL")

    @staticmethod
    def _audio_format(content_type: str | None, default: str) -> str:
        normalized = (content_type or "").split(";", 1)[0].strip().lower()
        if normalized in {"audio/mpeg", "audio/mp3"}:
            return "mp3"
        if normalized in {"audio/wav", "audio/x-wav", "audio/wave"}:
            return "wav"
        if normalized == "audio/pcm":
            return "pcm"
        return default


__all__ = ["AliyunTTSClient", "AliyunTTSClientError", "AliyunTTSSettings"]
