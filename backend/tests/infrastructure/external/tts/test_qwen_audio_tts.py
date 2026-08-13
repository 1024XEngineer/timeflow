"""Qwen-Audio-TTS raw WebSocket protocol and lifecycle tests."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import replace
from typing import Any

import pytest

from timeflow.infrastructure.external.tts.qwen_audio_tts import (
    QwenAudioTts,
    ResultType,
    ServerEvent,
    ServerEventType,
    build_continue_task,
    build_finish_task,
    build_run_task,
    parse_server_event,
)
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.speech import (
    SpeechSegment,
    TtsAudioChunk,
    TtsCompleted,
    TtsConnectionError,
    TtsProtocolError,
    TtsSynthesisError,
)


class FakeWebSocket:
    def __init__(
        self,
        incoming: list[str | bytes | BaseException],
        *,
        send_error: BaseException | None = None,
    ) -> None:
        self._incoming: asyncio.Queue[str | bytes | BaseException] = asyncio.Queue()
        for message in incoming:
            self._incoming.put_nowait(message)
        self._send_error = send_error
        self.sent_text: list[str] = []
        self.closed = False
        self.recv_cancelled = False

    async def send(self, message: str) -> None:
        if self._send_error is not None:
            raise self._send_error
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
        aliyun_tts_ws_url="wss://workspace.example/api-ws/v1/inference",
        aliyun_tts_api_key="test-api-key",
    )


async def wait_for_sent(websocket: FakeWebSocket, count: int = 1) -> None:
    """Wait until the provider has sent the expected number of frames."""
    for _ in range(100):
        if len(websocket.sent_text) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"expected {count} sent frames, received {len(websocket.sent_text)}")


async def segments(*values: str) -> AsyncIterator[SpeechSegment]:
    for index, value in enumerate(values):
        yield SpeechSegment(index, value, "command_result")


def server_event(task_id: str, event: str, payload: object | None = None, **header: Any) -> str:
    return json.dumps(
        {
            "header": {"task_id": task_id, "event": event, "attributes": {}, **header},
            "payload": {} if payload is None else payload,
        }
    )


def result_event(task_id: str, result_type: str, index: int, text: str = "") -> str:
    return server_event(
        task_id,
        "result-generated",
        {
            "output": {
                "type": result_type,
                "sentence": {"index": index, "words": []},
                "original_text": text,
            }
        },
    )


def test_client_events_match_documented_shapes() -> None:
    run = build_run_task("task-1", model="qwen-audio-3.0-tts-flash", voice="voice-1")
    assert run == {
        "header": {"action": "run-task", "task_id": "task-1", "streaming": "duplex"},
        "payload": {
            "task_group": "audio",
            "task": "tts",
            "function": "SpeechSynthesizer",
            "model": "qwen-audio-3.0-tts-flash",
            "input": {},
            "parameters": {
                "text_type": "PlainText",
                "voice": "voice-1",
                "format": "pcm",
                "sample_rate": 24000,
                "volume": 50,
                "rate": 1.0,
                "pitch": 1.0,
                "enable_ssml": False,
            },
        },
    }
    assert build_continue_task("task-1", "你好") == {
        "header": {"action": "continue-task", "task_id": "task-1", "streaming": "duplex"},
        "payload": {"input": {"text": "你好"}},
    }
    assert build_finish_task("task-1") == {
        "header": {"action": "finish-task", "task_id": "task-1", "streaming": "duplex"},
        "payload": {"input": {}},
    }
    assert build_finish_task("task-1", cancel=True)["payload"] == {"input": {"directive": "cancel"}}
    with pytest.raises(ValueError, match="non-empty"):
        build_continue_task("task-1", "  ")


def test_server_events_are_strictly_parsed() -> None:
    assert parse_server_event(
        json.loads(server_event("task-1", "task-started")), "task-1"
    ) == ServerEvent(ServerEventType.TASK_STARTED, "task-1")
    assert parse_server_event(
        json.loads(result_event("task-1", "sentence-synthesis", 2, "你好")), "task-1"
    ) == ServerEvent(
        ServerEventType.RESULT_GENERATED,
        "task-1",
        ResultType.SENTENCE_SYNTHESIS,
        2,
        "你好",
    )
    finished = parse_server_event(
        json.loads(server_event("task-1", "task-finished", {"usage": {"characters": 2}})),
        "task-1",
    )
    assert finished == ServerEvent(ServerEventType.TASK_FINISHED, "task-1", characters=2)

    with pytest.raises(TtsProtocolError, match="active task"):
        parse_server_event(json.loads(server_event("other", "task-started")), "task-1")
    with pytest.raises(TtsProtocolError, match="unsupported event"):
        parse_server_event(json.loads(server_event("task-1", "unknown")), "task-1")
    with pytest.raises(TtsProtocolError, match="sentence index"):
        parse_server_event(
            {
                "header": {"task_id": "task-1", "event": "result-generated"},
                "payload": {
                    "output": {
                        "type": "sentence-begin",
                        "sentence": {},
                        "original_text": "hi",
                    }
                },
            },
            "task-1",
        )
    with pytest.raises(TtsSynthesisError, match="failed") as captured:
        parse_server_event(
            {
                "header": {
                    "task_id": "task-1",
                    "event": "task-failed",
                    "error_message": "secret provider detail",
                },
                "payload": {},
            },
            "task-1",
        )
    assert "secret provider detail" not in str(captured.value)


@pytest.mark.parametrize(
    "message",
    [
        {},
        {"header": {}, "payload": {}},
        {"header": {"task_id": "task-1"}, "payload": {}},
        {"header": {"task_id": "task-1", "event": "task-started"}, "payload": []},
        {
            "header": {"task_id": "task-1", "event": "result-generated"},
            "payload": {"output": {"type": "unknown", "sentence": {"index": 0}}},
        },
        {
            "header": {"task_id": "task-1", "event": "result-generated"},
            "payload": {
                "output": {
                    "type": "sentence-begin",
                    "sentence": {"index": 0},
                    "original_text": 1,
                }
            },
        },
        {
            "header": {"task_id": "task-1", "event": "task-finished"},
            "payload": {"usage": {"characters": -1}},
        },
    ],
)
def test_invalid_server_event_fields_are_rejected(message: Mapping[str, object]) -> None:
    with pytest.raises(TtsProtocolError):
        parse_server_event(message, "task-1")


@pytest.mark.asyncio
async def test_raw_event_json_and_shape_are_validated(settings: Settings) -> None:
    for raw in ("not-json", "[]"):
        websocket = FakeWebSocket([raw])
        provider = QwenAudioTts(settings, connector=FakeConnector(websocket))
        with pytest.raises(TtsProtocolError):
            _ = [event async for event in provider.stream(segments("你好"))]
        assert websocket.closed is True


@pytest.mark.asyncio
async def test_audio_before_task_started_is_rejected(settings: Settings) -> None:
    websocket = FakeWebSocket([b"early-audio"])
    provider = QwenAudioTts(settings, connector=FakeConnector(websocket))

    with pytest.raises(TtsProtocolError, match="before task-started"):
        _ = [event async for event in provider.stream(segments("你好"))]


@pytest.mark.asyncio
async def test_connect_and_setup_failures_are_safe(settings: Settings) -> None:
    async def failing_connector(
        url: str, headers: Mapping[str, str], timeout: float
    ) -> FakeWebSocket:
        del url, headers, timeout
        raise RuntimeError("test-api-key")

    provider = QwenAudioTts(settings, connector=failing_connector)
    with pytest.raises(TtsConnectionError, match="Failed to connect") as captured:
        _ = [event async for event in provider.stream(segments("你好"))]
    assert "test-api-key" not in str(captured.value)

    websocket = FakeWebSocket([RuntimeError("closed")])
    provider = QwenAudioTts(settings, connector=FakeConnector(websocket))
    with pytest.raises(TtsConnectionError, match="task setup"):
        _ = [event async for event in provider.stream(segments("你好"))]


@pytest.mark.asyncio
async def test_sender_validation_failures_surface_immediately(settings: Settings) -> None:
    cases = [
        [SpeechSegment(1, "wrong index", "command_result")],
        [SpeechSegment(0, " ", "command_result")],
        [SpeechSegment(0, "x" * 20001, "command_result")],
        [SpeechSegment(index, "x" * 20000, "command_result") for index in range(11)],
    ]
    messages = ["indexes", "non-empty", "text limit", "cumulative"]

    for case, message in zip(cases, messages, strict=True):
        websocket = FakeWebSocket([])
        provider = QwenAudioTts(settings, connector=FakeConnector(websocket))

        async def source(
            source_segments: list[SpeechSegment] = case,
        ) -> AsyncIterator[SpeechSegment]:
            for segment in source_segments:
                yield segment

        stream = provider.stream(source())
        pending = asyncio.create_task(anext(stream))
        await wait_for_sent(websocket)
        task_id = json.loads(websocket.sent_text[0])["header"]["task_id"]
        websocket.feed(server_event(task_id, "task-started"))
        with pytest.raises(TtsProtocolError, match=message):
            await asyncio.wait_for(pending, timeout=1)
        assert websocket.closed is True


@pytest.mark.asyncio
async def test_expected_audio_and_empty_audio_are_rejected(settings: Settings) -> None:
    for following, message in [
        (server_event("TASK", "task-finished"), "not followed"),
        (b"", "empty audio"),
    ]:
        websocket = FakeWebSocket([])
        provider = QwenAudioTts(settings, connector=FakeConnector(websocket))
        stream = provider.stream(segments("你好"))
        pending = asyncio.create_task(anext(stream))
        await wait_for_sent(websocket)
        task_id = json.loads(websocket.sent_text[0])["header"]["task_id"]
        websocket.feed(server_event(task_id, "task-started"))
        websocket.feed(result_event(task_id, "sentence-synthesis", 0, "你好"))
        websocket.feed(
            following.replace("TASK", task_id) if isinstance(following, str) else following
        )
        with pytest.raises(TtsProtocolError, match=message):
            await pending


@pytest.mark.asyncio
async def test_stream_sends_ordered_segments_and_yields_audio(settings: Settings) -> None:
    websocket = FakeWebSocket([])
    connector = FakeConnector(websocket)
    provider = QwenAudioTts(settings, connector=connector)
    stream = provider.stream(segments("第一句。", "第二句。"))

    consume_task = asyncio.create_task(anext(stream))
    await wait_for_sent(websocket)
    run = json.loads(websocket.sent_text[0])
    task_id = run["header"]["task_id"]
    websocket.feed(server_event(task_id, "task-started"))
    await wait_for_sent(websocket, 4)
    websocket.feed(result_event(task_id, "sentence-synthesis", 0, "第一句。"))
    websocket.feed(b"audio-1")

    assert await asyncio.wait_for(consume_task, timeout=1) == TtsAudioChunk(b"audio-1")
    sent = [json.loads(item) for item in websocket.sent_text]
    assert [item["header"]["action"] for item in sent] == [
        "run-task",
        "continue-task",
        "continue-task",
        "finish-task",
    ]
    assert [item["payload"]["input"]["text"] for item in sent[1:3]] == [
        "第一句。",
        "第二句。",
    ]
    assert all(item["header"]["task_id"] == task_id for item in sent)
    assert connector.headers == {"Authorization": "Bearer test-api-key"}

    websocket.feed(result_event(task_id, "sentence-end", 0, "第一句。"))
    websocket.feed(server_event(task_id, "task-finished", {"usage": {"characters": 8}}))
    assert await asyncio.wait_for(anext(stream), timeout=1) == TtsCompleted(8)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_audio_can_arrive_before_segment_source_finishes(settings: Settings) -> None:
    release = asyncio.Event()

    async def open_segments() -> AsyncIterator[SpeechSegment]:
        yield SpeechSegment(0, "第一句。", "command_result")
        await release.wait()
        yield SpeechSegment(1, "第二句。", "command_result")

    websocket = FakeWebSocket([])
    provider = QwenAudioTts(settings, connector=FakeConnector(websocket))
    stream = provider.stream(open_segments())
    first = asyncio.create_task(anext(stream))
    await wait_for_sent(websocket)
    task_id = json.loads(websocket.sent_text[0])["header"]["task_id"]
    websocket.feed(server_event(task_id, "task-started"))
    await wait_for_sent(websocket, 2)
    websocket.feed(result_event(task_id, "sentence-synthesis", 0, "第一句。"))
    websocket.feed(b"first-audio")

    assert await asyncio.wait_for(first, timeout=1) == TtsAudioChunk(b"first-audio")
    actions = [json.loads(item)["header"]["action"] for item in websocket.sent_text]
    assert actions == ["run-task", "continue-task"]

    release.set()
    await wait_for_sent(websocket, 4)
    websocket.feed(server_event(task_id, "task-finished", {"usage": {"characters": 8}}))
    assert await asyncio.wait_for(anext(stream), timeout=1) == TtsCompleted(8)


@pytest.mark.asyncio
async def test_protocol_failures_close_connection(settings: Settings) -> None:
    websocket = FakeWebSocket([])
    provider = QwenAudioTts(settings, connector=FakeConnector(websocket))
    stream = provider.stream(segments("你好"))
    pending = asyncio.create_task(anext(stream))
    await wait_for_sent(websocket)
    task_id = json.loads(websocket.sent_text[0])["header"]["task_id"]
    websocket.feed(server_event(task_id, "task-started"))
    websocket.feed(b"unexpected")

    with pytest.raises(TtsProtocolError, match="unexpected binary"):
        await pending
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_cancellation_sends_documented_cancel_and_closes(settings: Settings) -> None:
    websocket = FakeWebSocket([])
    provider = QwenAudioTts(settings, connector=FakeConnector(websocket))
    stream = provider.stream(segments("一段较长的文本"))
    task = asyncio.create_task(anext(stream))
    await wait_for_sent(websocket)
    task_id = json.loads(websocket.sent_text[0])["header"]["task_id"]
    websocket.feed(server_event(task_id, "task-started"))
    await wait_for_sent(websocket, 3)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    sent = [json.loads(item) for item in websocket.sent_text]
    assert sent[-1] == build_finish_task(task_id, cancel=True)
    assert websocket.closed is True


@pytest.mark.asyncio
async def test_missing_provider_settings_are_rejected(settings: Settings) -> None:
    for field, message in [
        ("aliyun_tts_ws_url", "URL"),
        ("aliyun_tts_api_key", "API key"),
        ("aliyun_tts_model", "model"),
        ("aliyun_tts_voice", "voice"),
    ]:
        provider = QwenAudioTts(replace(settings, **{field: ""}))
        with pytest.raises(TtsConnectionError, match=message):
            _ = [event async for event in provider.stream(segments("你好"))]
