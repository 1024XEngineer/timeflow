"""Qwen3-ASR realtime protocol and lifecycle tests."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import replace
from typing import Any

import pytest

from timeflow.infrastructure.external.asr.qwen_realtime import (
    QwenRealtimeAsr,
    build_audio_append,
    build_qwen_url,
    build_session_finish,
    build_session_update,
    parse_server_event,
)
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.conversation.asr import (
    AsrConnectionError,
    AsrProtocolError,
    AsrTranscriptionError,
    TranscriptCompleted,
    TranscriptPreview,
)


class FakeWebSocket:
    def __init__(self, incoming: list[str | bytes]) -> None:
        self._incoming: asyncio.Queue[str | bytes | BaseException] = asyncio.Queue()
        for message in incoming:
            self._incoming.put_nowait(message)
        self.sent_text: list[str] = []
        self.closed = False
        self.recv_cancelled = False

    async def send(self, message: str) -> None:
        self.sent_text.append(message)

    async def recv(self) -> str | bytes:
        try:
            result = await self._incoming.get()
        except asyncio.CancelledError:
            self.recv_cancelled = True
            raise
        if isinstance(result, BaseException):
            raise result
        return result

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True

    def feed(self, message: str | bytes | BaseException) -> None:
        self._incoming.put_nowait(message)


class FakeConnector:
    def __init__(self, websocket: FakeWebSocket) -> None:
        self.websocket = websocket
        self.url = ""
        self.headers: Mapping[str, str] = {}
        self.timeout = 0.0

    async def __call__(
        self,
        url: str,
        headers: Mapping[str, str],
        timeout: float,
    ) -> FakeWebSocket:
        self.url = url
        self.headers = headers
        self.timeout = timeout
        return self.websocket


@pytest.fixture
def settings() -> Settings:
    return Settings(
        app_name="Test API",
        environment="test",
        database_url="sqlite+pysqlite:///:memory:",
        ws_handshake_timeout_seconds=5.0,
        ws_max_unauthenticated_connections=100,
        ws_audio_queue_max_chunks=32,
        ws_max_audio_duration_ms=120000,
        aliyun_asr_ws_url=("wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime"),
        aliyun_asr_api_key="test-api-key",
    )


async def audio_chunks(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


def server_event(event_type: str, **fields: Any) -> str:
    return json.dumps({"event_id": f"server-{event_type}", "type": event_type, **fields})


def test_build_url_adds_model_and_preserves_other_query() -> None:
    url = build_qwen_url(
        "wss://workspace.example/realtime?trace=1&model=old",
        "qwen3-asr-flash-realtime",
    )
    assert url == ("wss://workspace.example/realtime?trace=1&model=qwen3-asr-flash-realtime")


def test_client_events_follow_documented_shapes() -> None:
    session_update = build_session_update("zh", 0.0, 400)
    audio_append = build_audio_append(b"\x00\x01")
    session_finish = build_session_finish()

    assert session_update["type"] == "session.update"
    assert session_update["session"] == {
        "input_audio_format": "pcm",
        "sample_rate": 16000,
        "input_audio_transcription": {"language": "zh"},
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.0,
            "silence_duration_ms": 400,
        },
    }
    assert audio_append["audio"] == "AAE="
    assert set(audio_append) == {"event_id", "type", "audio"}
    assert set(session_finish) == {"event_id", "type"}
    event_ids = {
        str(session_update["event_id"]),
        audio_append["event_id"],
        session_finish["event_id"],
    }
    assert len(event_ids) == 3
    assert all(event_id.startswith("event_") for event_id in event_ids)


def test_parse_transcript_events() -> None:
    assert parse_server_event(
        {
            "type": "conversation.item.input_audio_transcription.text",
            "text": "今天",
            "stash": "天气",
        }
    ) == TranscriptPreview(text="今天天气")
    assert parse_server_event(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "今天天气怎么样",
        }
    ) == TranscriptCompleted(text="今天天气怎么样")


def test_parse_provider_errors() -> None:
    with pytest.raises(AsrProtocolError, match="invalid"):
        parse_server_event(
            {
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "code": "invalid_value",
                    "message": "invalid",
                    "param": "session",
                    "event_id": "event_123",
                },
            }
        )

    with pytest.raises(AsrTranscriptionError, match="failed"):
        parse_server_event(
            {
                "type": "conversation.item.input_audio_transcription.failed",
                "item_id": "item_1",
                "content_index": 0,
                "error": {"code": "recognition_failed", "message": "failed", "param": "audio"},
            }
        )


@pytest.mark.parametrize(
    ("message", "error"),
    [
        ({}, "type"),
        (
            {"type": "conversation.item.input_audio_transcription.text", "text": 1, "stash": ""},
            "text",
        ),
        ({"type": "error", "error": "quota"}, "error object"),
    ],
)
def test_parse_rejects_malformed_provider_event_shapes(
    message: dict[str, object],
    error: str,
) -> None:
    with pytest.raises(AsrProtocolError, match=error):
        parse_server_event(message)


def test_blank_completed_transcripts_and_unknown_events_are_ignored() -> None:
    assert (
        parse_server_event(
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "  ",
            }
        )
        is None
    )
    assert parse_server_event({"type": "provider.lifecycle.added"}) is None


@pytest.mark.asyncio
async def test_stream_sends_audio_yields_events_and_closes(settings: Settings) -> None:
    websocket = FakeWebSocket(
        [
            server_event("session.created", session={"id": "sess_1"}),
            server_event("session.updated", session={"id": "sess_1"}),
            server_event(
                "conversation.item.input_audio_transcription.text",
                text="明天",
                stash="上午",
            ),
            server_event(
                "conversation.item.input_audio_transcription.completed",
                transcript="明天上午开会",
            ),
            server_event("session.finished"),
        ]
    )
    connector = FakeConnector(websocket)
    provider = QwenRealtimeAsr(settings, connector=connector)

    events = [event async for event in provider.stream(audio_chunks(b"audio", b""))]

    assert events == [
        TranscriptPreview(text="明天上午"),
        TranscriptCompleted(text="明天上午开会"),
    ]
    sent = [json.loads(message) for message in websocket.sent_text]
    assert [message["type"] for message in sent] == [
        "session.update",
        "input_audio_buffer.append",
        "session.finish",
    ]
    assert connector.url.endswith("?model=qwen3-asr-flash-realtime")
    assert connector.headers == {"Authorization": "Bearer test-api-key"}
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_completed_is_yielded_before_session_finished(settings: Settings) -> None:
    websocket = FakeWebSocket(
        [
            server_event("session.created", session={"id": "sess_1"}),
            server_event("session.updated", session={"id": "sess_1"}),
            server_event(
                "conversation.item.input_audio_transcription.completed",
                transcript="低延迟结果",
            ),
        ]
    )
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))
    stream = provider.stream(audio_chunks(b"audio"))

    event = await asyncio.wait_for(anext(stream), timeout=1)

    assert event == TranscriptCompleted(text="低延迟结果")
    assert websocket.closed is False
    websocket.feed(server_event("session.finished"))
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=1)
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_completed_does_not_finish_open_audio_stream(settings: Settings) -> None:
    release_audio = asyncio.Event()

    async def open_audio() -> AsyncIterator[bytes]:
        yield b"first"
        await release_audio.wait()
        yield b"second"

    websocket = FakeWebSocket(
        [
            server_event("session.created", session={"id": "sess_1"}),
            server_event("session.updated", session={"id": "sess_1"}),
            server_event(
                "conversation.item.input_audio_transcription.completed",
                transcript="第一句",
            ),
        ]
    )
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))
    stream = provider.stream(open_audio())

    assert await asyncio.wait_for(anext(stream), timeout=1) == TranscriptCompleted(text="第一句")
    await asyncio.sleep(0)
    assert "session.finish" not in [json.loads(item)["type"] for item in websocket.sent_text]

    release_audio.set()
    websocket.feed(server_event("session.finished"))
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=1)


@pytest.mark.asyncio
async def test_protocol_and_configuration_failures_close_connection(settings: Settings) -> None:
    websocket = FakeWebSocket(
        [server_event("session.created", session={"id": "sess_1"}), b"binary"]
    )
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))

    with pytest.raises(AsrProtocolError, match="binary"):
        _ = [event async for event in provider.stream(audio_chunks())]
    assert websocket.closed is True

    missing_key = replace(settings, aliyun_asr_api_key="")
    provider = QwenRealtimeAsr(missing_key, connector=FakeConnector(FakeWebSocket([])))
    with pytest.raises(AsrConnectionError, match="API key"):
        _ = [event async for event in provider.stream(audio_chunks())]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("aliyun_asr_ws_url", "URL"),
        ("aliyun_asr_model", "model"),
    ],
)
async def test_other_missing_connection_settings_fail_before_connect(
    settings: Settings,
    field: str,
    message: str,
) -> None:
    connector = FakeConnector(FakeWebSocket([]))
    provider = QwenRealtimeAsr(replace(settings, **{field: ""}), connector=connector)

    with pytest.raises(AsrConnectionError, match=message):
        _ = [event async for event in provider.stream(audio_chunks())]
    assert connector.url == ""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "message"),
    [
        (TimeoutError(), "Timed out connecting"),
        (ConnectionResetError(), "Failed to connect"),
        (AsrProtocolError("upstream protocol"), "upstream protocol"),
    ],
)
async def test_connect_failures_are_classified_without_leaking_provider_details(
    settings: Settings,
    failure: BaseException,
    message: str,
) -> None:
    async def failing_connector(
        url: str,
        headers: Mapping[str, str],
        timeout: float,
    ) -> FakeWebSocket:
        del url, headers, timeout
        raise failure

    provider = QwenRealtimeAsr(settings, connector=failing_connector)

    with pytest.raises(
        AsrConnectionError if not isinstance(failure, AsrProtocolError) else AsrProtocolError,
        match=message,
    ):
        _ = [event async for event in provider.stream(audio_chunks())]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("first_frame", "message"),
    [
        (server_event("session.finished"), "session.finished"),
        (server_event("provider.lifecycle.added"), "unknown"),
        (
            server_event(
                "conversation.item.input_audio_transcription.completed",
                transcript="too early",
            ),
            "TranscriptCompleted",
        ),
    ],
)
async def test_setup_requires_the_expected_control_event(
    settings: Settings,
    first_frame: str,
    message: str,
) -> None:
    websocket = FakeWebSocket([first_frame])
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))

    with pytest.raises(AsrProtocolError, match=message):
        _ = [event async for event in provider.stream(audio_chunks())]
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_setup_and_finish_waits_have_distinct_timeout_errors(settings: Settings) -> None:
    setup_socket = FakeWebSocket([])
    setup_provider = QwenRealtimeAsr(
        replace(settings, aliyun_asr_connect_timeout_seconds=0.001),
        connector=FakeConnector(setup_socket),
    )
    with pytest.raises(AsrConnectionError, match="session.created"):
        _ = [event async for event in setup_provider.stream(audio_chunks())]

    finish_socket = FakeWebSocket(
        [server_event("session.created"), server_event("session.updated")]
    )
    finish_provider = QwenRealtimeAsr(
        replace(settings, aliyun_asr_finish_timeout_seconds=0.001),
        connector=FakeConnector(finish_socket),
    )
    with pytest.raises(AsrConnectionError, match="session.finished"):
        _ = [event async for event in finish_provider.stream(audio_chunks())]

    assert setup_socket.closed is True
    assert finish_socket.closed is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("frame", "message"),
    [
        ("not-json", "invalid JSON"),
        ("[]", "JSON object"),
    ],
)
async def test_stream_rejects_malformed_text_frames_after_setup(
    settings: Settings,
    frame: str,
    message: str,
) -> None:
    websocket = FakeWebSocket(
        [server_event("session.created"), server_event("session.updated"), frame]
    )
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))

    with pytest.raises(AsrProtocolError, match=message):
        _ = [event async for event in provider.stream(audio_chunks(b"audio"))]
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_cancellation_closes_connection(settings: Settings) -> None:
    websocket = FakeWebSocket(
        [
            server_event("session.created", session={"id": "sess_1"}),
            server_event("session.updated", session={"id": "sess_1"}),
        ]
    )
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))

    async def consume() -> None:
        async for _ in provider.stream(audio_chunks(b"audio")):
            pass

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert websocket.recv_cancelled is True
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_sender_failure_cancels_pending_receive_task(settings: Settings) -> None:
    async def failing_audio() -> AsyncIterator[bytes]:
        yield b"audio"
        raise RuntimeError("audio source failed")

    websocket = FakeWebSocket(
        [
            server_event("session.created", session={"id": "sess_1"}),
            server_event("session.updated", session={"id": "sess_1"}),
        ]
    )
    provider = QwenRealtimeAsr(settings, connector=FakeConnector(websocket))

    with pytest.raises(AsrConnectionError, match="ASR WebSocket connection failed"):
        _ = [event async for event in provider.stream(failing_audio())]

    assert websocket.recv_cancelled is True
    assert websocket.closed is True
