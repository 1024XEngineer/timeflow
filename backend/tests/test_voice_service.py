"""Tests for the voice schedule parsing service."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterable
from dataclasses import dataclass
from typing import Any

from timeflow.business.voice import (
    SpeechRecognitionConfig,
    SpeechRecognitionResult,
    StructuredLLMResult,
    VoiceScheduleParsingService,
)
from timeflow.intelligence.schedule_parser import ScheduleDraftParser


@dataclass
class FakeSpeechClient:
    """Fake streaming ASR client used by service tests."""

    text: str
    chunks: list[bytes]
    config: SpeechRecognitionConfig | None

    def __init__(self, text: str) -> None:
        self.text = text
        self.chunks = []
        self.config = None

    async def recognize(
        self,
        audio_chunks: AsyncIterable[bytes],
        config: SpeechRecognitionConfig | None = None,
    ) -> SpeechRecognitionResult:
        self.config = config
        async for chunk in audio_chunks:
            self.chunks.append(chunk)
        return SpeechRecognitionResult(text=self.text)


@dataclass
class FakeLLMClient:
    """Fake structured LLM client used by service tests."""

    response: dict[str, Any]
    prompts: list[str]

    def __init__(self, response: dict[str, Any]) -> None:
        self.response = response
        self.prompts = []

    async def generate_json(
        self,
        prompt: str,
        *,
        schema: dict[str, Any],
        response_name: str = "timeflow_response",
        system_prompt: str | None = None,
        temperature: float | None = None,
    ) -> StructuredLLMResult:
        self.prompts.append(prompt)
        return StructuredLLMResult(
            data=self.response,
            raw_text=json.dumps(self.response, ensure_ascii=False),
        )


async def audio_stream() -> AsyncIterable[bytes]:
    """Yield small binary audio chunks as a websocket handler would."""
    yield b"first"
    yield b"second"


def test_voice_service_parses_streamed_audio_into_schedule_draft() -> None:
    """The service connects streaming ASR and structured LLM parsing."""
    speech_client = FakeSpeechClient("明天下午三点在陆家嘴开会")
    llm_client = FakeLLMClient(
        {
            "title": "开会",
            "start_time": "2026-07-30T15:00",
            "end_time": None,
            "location_name": "陆家嘴",
        }
    )
    parser = ScheduleDraftParser(llm_client)
    service = VoiceScheduleParsingService(speech_client, parser)
    config = SpeechRecognitionConfig(sample_rate_hz=16000)

    result = asyncio.run(service.parse_audio(audio_stream(), config))

    assert speech_client.chunks == [b"first", b"second"]
    assert speech_client.config == config
    assert result.speech.text == "明天下午三点在陆家嘴开会"
    assert result.parsed.draft.title == "开会"
    assert result.parsed.draft.schedule_type == "time"
    assert "明天下午三点在陆家嘴开会" in llm_client.prompts[0]


def test_voice_service_can_parse_existing_text() -> None:
    """WS handlers can bypass ASR when they already have text."""
    speech_client = FakeSpeechClient("不会被调用")
    llm_client = FakeLLMClient(
        {
            "title": "取文件",
            "start_time": None,
            "end_time": None,
            "location_name": "公司前台",
        }
    )
    parser = ScheduleDraftParser(llm_client)
    service = VoiceScheduleParsingService(speech_client, parser)

    result = asyncio.run(service.parse_text("到公司前台取文件"))

    assert speech_client.chunks == []
    assert result.draft.schedule_type == "location"
    assert result.draft.title == "取文件"
