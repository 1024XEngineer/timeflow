"""语音流消息类型 vs 示例 JSON 的校验。"""

import pytest
from pydantic import ValidationError

from timeflow.infrastructure.websocket.messages.voice import (
    VoiceParseResult,
    VoiceStreamEnd,
    VoiceStreamEnded,
    VoiceStreamError,
    VoiceStreamStart,
    VoiceStreamStarted,
)


def test_voice_stream_start_matches_doc_example() -> None:
    message = VoiceStreamStart.model_validate(
        {
            "type": "voice.stream.start",
            "request_id": "req_audio_001",
            "payload": {"audio_format": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1},
        }
    )

    assert message.payload.sample_rate_hz == 16000


def test_voice_stream_started_matches_doc_example() -> None:
    message = VoiceStreamStarted.model_validate(
        {
            "type": "voice.stream.started",
            "request_id": "req_audio_001",
            "ok": True,
            "payload": {"stream_id": "stream_audio_001", "job_id": "job_audio_001"},
        }
    )

    assert message.payload.stream_id == "stream_audio_001"


def test_voice_stream_end_and_ended_match_doc_example() -> None:
    end = VoiceStreamEnd.model_validate(
        {
            "type": "voice.stream.end",
            "request_id": "req_audio_001",
            "payload": {"stream_id": "stream_audio_001"},
        }
    )
    ended = VoiceStreamEnded.model_validate(
        {
            "type": "voice.stream.ended",
            "request_id": "req_audio_001",
            "ok": True,
            "payload": {
                "stream_id": "stream_audio_001",
                "job_id": "job_audio_001",
                "status": "processing",
            },
        }
    )

    assert end.payload.stream_id == ended.payload.stream_id


def test_voice_stream_error_matches_doc_example() -> None:
    error = VoiceStreamError.model_validate(
        {
            "type": "voice.stream.error",
            "request_id": "req_audio_001",
            "ok": False,
            "error": {
                "code": "UNSUPPORTED_AUDIO_FORMAT",
                "message": "音频格式不支持",
                "details": {"audio_format": "aac", "supported_formats": ["pcm_s16le"]},
            },
        }
    )

    assert error.error.code == "UNSUPPORTED_AUDIO_FORMAT"
    assert error.error.details == {
        "audio_format": "aac",
        "supported_formats": ["pcm_s16le"],
    }


def test_voice_parse_result_success_matches_doc_example() -> None:
    result = VoiceParseResult.model_validate(
        {
            "type": "voice.parse.result",
            "request_id": "req_audio_001",
            "job_id": "job_audio_001",
            "status": "ready_for_confirmation",
            "draft": {
                "schedule_type": "time",
                "title": "开会",
                "start_time": "2026-07-29T15:00:00+08:00",
                "end_time": None,
                "timezone": "Asia/Shanghai",
                "location_name": "陆家嘴",
                "geofence_radius_meters": 100,
                "time_remind_offset_minutes": 15,
            },
            "missing_fields": ["location_address"],
            "ambiguous_fields": [],
            "needs_confirmation": True,
        }
    )

    assert result.draft is not None
    assert result.draft.title == "开会"
    assert result.needs_confirmation is True


def test_voice_parse_result_failed_matches_doc_example() -> None:
    result = VoiceParseResult.model_validate(
        {
            "type": "voice.parse.result",
            "request_id": "req_audio_001",
            "job_id": "job_audio_001",
            "status": "failed",
            "error": {
                "code": "VOICE_PARSE_FAILED",
                "message": "语音解析失败,请重新录音或手动创建",
                "details": {"stage": "asr"},
            },
        }
    )

    assert result.draft is None
    assert result.error is not None
    assert result.error.code == "VOICE_PARSE_FAILED"


def test_voice_stream_start_missing_required_field_is_rejected() -> None:
    with pytest.raises(ValidationError):
        VoiceStreamStart.model_validate(
            {"type": "voice.stream.start", "request_id": "req_audio_001", "payload": {}}
        )
