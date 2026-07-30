"""Tests for external model gateway helpers."""

import asyncio
import json
from collections.abc import AsyncIterator

import pytest

from timeflow.business.voice import SpeechRecognitionConfig, SpeechRecognitionResult
from timeflow.gateway.aliyun_asr import ASR_CLOSE_TIMEOUT_SECONDS, AliyunASRClient
from timeflow.gateway.openai_llm import OpenAILLMClient, OpenAIResponseError


class FakeAliyunWebSocket:
    """Minimal provider socket that proves send and receive run concurrently."""

    def __init__(self) -> None:
        self.sent_events: list[dict[str, object]] = []
        self.incoming: asyncio.Queue[str] = asyncio.Queue()
        self.partial_consumed = asyncio.Event()

    async def send(self, raw_message: str) -> None:
        event = json.loads(raw_message)
        self.sent_events.append(event)
        event_type = event["type"]
        if event_type == "session.update":
            await self.incoming.put(json.dumps({"type": "session.updated"}))
        elif event_type == "input_audio_buffer.append" and not self.partial_consumed.is_set():
            await self.incoming.put(
                json.dumps(
                    {
                        "type": "conversation.item.input_audio_transcription.text",
                        "stash": "明天",
                    },
                    ensure_ascii=False,
                )
            )
        elif event_type == "session.finish":
            await self.incoming.put(
                json.dumps(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "transcript": "明天下午三点开会",
                    },
                    ensure_ascii=False,
                )
            )
            await self.incoming.put(json.dumps({"type": "session.finished"}))

    def __aiter__(self) -> "FakeAliyunWebSocket":
        return self

    async def __anext__(self) -> str:
        message = await self.incoming.get()
        if "input_audio_transcription.text" in message:
            self.partial_consumed.set()
        return message


class FakeAliyunConnection:
    def __init__(self, websocket: FakeAliyunWebSocket) -> None:
        self.websocket = websocket

    async def __aenter__(self) -> FakeAliyunWebSocket:
        return self.websocket

    async def __aexit__(self, *_: object) -> None:
        return None


def test_aliyun_asr_extracts_transcript_from_nested_event() -> None:
    """Aliyun events can expose transcript fields in nested payloads."""
    event = {
        "type": "conversation.item.input_audio_transcription.completed",
        "data": {"transcript": "明天下午三点开会"},
    }

    assert AliyunASRClient._extract_text(event) == "明天下午三点开会"


def test_aliyun_asr_extracts_text_from_content_parts() -> None:
    """Some realtime events split text into content parts."""
    event = {
        "type": "transcription.completed",
        "content": [{"text": "去"}, {"text": "陆家嘴"}],
    }

    assert AliyunASRClient._extract_text(event) == "去陆家嘴"


def test_aliyun_asr_extracts_text_from_stash() -> None:
    """Realtime partial events may carry the running transcript in stash."""
    event = {
        "type": "conversation.item.input_audio_transcription.text",
        "stash": "明天下午三点在陆家嘴开会。",
        "text": "",
    }

    assert AliyunASRClient._extract_text(event) == "明天下午三点在陆家嘴开会。"


def test_aliyun_asr_rewrites_model_query_parameter() -> None:
    """The runtime model setting should override any stale URL query."""

    class SettingsStub:
        ws_url = "wss://example.com/api-ws/v1/realtime?model=old-model"
        api_key = "key"
        model = "new-model"

    client = AliyunASRClient(SettingsStub())

    assert client._build_ws_url() == "wss://example.com/api-ws/v1/realtime?model=new-model"


def test_aliyun_asr_builds_doc_aligned_session_update_event() -> None:
    """The session.update payload follows the official realtime ASR schema."""

    class SettingsStub:
        ws_url = "wss://example.com/api-ws/v1/realtime"
        api_key = "key"
        model = "new-model"

    client = AliyunASRClient(SettingsStub())
    event = client._build_session_update_event(
        SpeechRecognitionConfig(
            audio_format="pcm_s16le",
            sample_rate_hz=16000,
            channels=1,
            language="zh-CN",
        )
    )

    assert event["type"] == "session.update"
    assert event["session"] == {
        "modalities": ["text"],
        "input_audio_format": "pcm",
        "sample_rate": 16000,
        "input_audio_transcription": {"language": "zh"},
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.2,
            "silence_duration_ms": 400,
        },
    }


def test_aliyun_asr_omits_language_when_auto_detection_is_requested() -> None:
    class SettingsStub:
        ws_url = "wss://example.com/api-ws/v1/realtime"
        api_key = "key"
        model = "new-model"

    client = AliyunASRClient(SettingsStub())

    event = client._build_session_update_event(SpeechRecognitionConfig(language=None))

    assert event["session"]["input_audio_transcription"] == {}


def test_aliyun_asr_builds_session_finish_event() -> None:
    """Every mode must explicitly close the session after audio input ends."""

    class SettingsStub:
        ws_url = "wss://example.com/api-ws/v1/realtime"
        api_key = "key"
        model = "new-model"

    client = AliyunASRClient(SettingsStub())
    event = client._build_session_finish_event()

    assert event == {"event_id": "session.finish_1", "type": "session.finish"}


def test_aliyun_asr_builds_manual_turn_detection() -> None:
    """Manual endpointing disables server VAD and relies on an explicit commit."""

    assert (
        AliyunASRClient._build_turn_detection(SpeechRecognitionConfig(endpointing_mode="manual"))
        is None
    )


def test_aliyun_asr_streams_vad_audio_while_consuming_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A partial provider event is consumed before the next input chunk is produced."""

    class SettingsStub:
        ws_url = "wss://example.com/api-ws/v1/realtime"
        api_key = "key"
        model = "qwen3-asr-flash-realtime"

    websocket = FakeAliyunWebSocket()
    connect_options: dict[str, object] = {}

    def fake_connect(*_: object, **__: object) -> FakeAliyunConnection:
        connect_options.update(__)
        return FakeAliyunConnection(websocket)

    monkeypatch.setattr("timeflow.gateway.aliyun_asr.connect", fake_connect)

    async def audio_chunks() -> AsyncIterator[bytes]:
        yield b"first"
        await asyncio.wait_for(websocket.partial_consumed.wait(), timeout=1)
        yield b"second"

    async def scenario() -> SpeechRecognitionResult:
        client = AliyunASRClient(SettingsStub())
        return await asyncio.wait_for(client.recognize(audio_chunks()), timeout=1)

    result = asyncio.run(scenario())
    sent_types = [event["type"] for event in websocket.sent_events]

    assert result.text == "明天下午三点开会"
    assert sent_types.count("input_audio_buffer.append") == 2
    assert "input_audio_buffer.commit" not in sent_types
    assert sent_types[-1] == "session.finish"
    assert result.raw_events[-1]["type"] == "session.finished"
    assert connect_options["close_timeout"] == ASR_CLOSE_TIMEOUT_SECONDS


def test_openai_builds_responses_api_input() -> None:
    """The wrapper uses Responses API message input format."""
    messages = OpenAILLMClient._build_input(
        "提取日程",
        "你是日程解析助手",
    )

    assert messages == [
        {
            "role": "system",
            "content": [{"type": "input_text", "text": "你是日程解析助手"}],
        },
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "提取日程"}],
        },
    ]


def test_openai_response_error_is_runtime_error() -> None:
    """Callers can catch provider failures through one gateway exception."""
    with pytest.raises(OpenAIResponseError):
        raise OpenAIResponseError("OpenAI returned empty JSON text")


def test_openai_client_defers_missing_credentials_until_first_request() -> None:
    class SettingsStub:
        base_url = "https://api.openai.com/v1"
        api_key = ""
        model = "gpt-4.1-mini"

    client = OpenAILLMClient(SettingsStub())

    with pytest.raises(OpenAIResponseError, match="API key is not configured"):
        client._get_client()

    asyncio.run(client.aclose())
