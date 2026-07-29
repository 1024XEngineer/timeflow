"""Tests for external model gateway helpers."""

import pytest

from timeflow.business.voice import SpeechRecognitionConfig
from timeflow.gateway.aliyun_asr import AliyunASRClient
from timeflow.gateway.openai_llm import OpenAILLMClient, OpenAIResponseError


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
        "input_audio_format": "pcm",
        "sample_rate": 16000,
        "input_audio_transcription": {"language": "zh"},
        "turn_detection": None,
    }


def test_aliyun_asr_builds_session_finish_event() -> None:
    """Manual mode must explicitly close the session after commit."""

    class SettingsStub:
        ws_url = "wss://example.com/api-ws/v1/realtime"
        api_key = "key"
        model = "new-model"

    client = AliyunASRClient(SettingsStub())
    event = client._build_session_finish_event()

    assert event == {"event_id": "session.finish_1", "type": "session.finish"}


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
