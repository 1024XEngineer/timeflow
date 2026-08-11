"""OpenAI-compatible streaming LLM adapter tests."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import replace
from types import SimpleNamespace

import pytest

from timeflow.infrastructure.external.llm.openai_compatible import OpenAICompatibleLlm
from timeflow.infrastructure.settings import Settings
from timeflow.intelligence.conversation.llm import (
    AssistantToolCallMessage,
    ChatMessage,
    LlmProtocolError,
    LlmProviderError,
    LlmStreamCompleted,
    LlmUsage,
    TextDelta,
    ToolCall,
    ToolCallDelta,
    ToolDefinition,
    ToolResultMessage,
)


class FakeStream:
    def __init__(self, chunks: Sequence[object]) -> None:
        self._chunks = iter(chunks)
        self.closed = False

    def __aiter__(self) -> FakeStream:
        return self

    async def __anext__(self) -> object:
        try:
            return next(self._chunks)
        except StopIteration as exc:
            raise StopAsyncIteration from exc

    async def close(self) -> None:
        self.closed = True


class BlockingFakeStream:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.closed = False

    def __aiter__(self) -> BlockingFakeStream:
        return self

    async def __anext__(self) -> object:
        self.started.set()
        await asyncio.Event().wait()
        raise StopAsyncIteration

    async def close(self) -> None:
        self.closed = True


class FakeCompletions:
    def __init__(self, result: object | BaseException) -> None:
        self.result = result
        self.requests: list[dict[str, object]] = []

    async def create(self, **kwargs: object) -> object:
        self.requests.append(kwargs)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class FakeClient:
    def __init__(self, result: object | BaseException) -> None:
        self.chat = SimpleNamespace(completions=FakeCompletions(result))


def settings() -> Settings:
    return Settings(
        app_name="Test API",
        environment="test",
        database_url="sqlite+pysqlite:///:memory:",
        ws_handshake_timeout_seconds=5.0,
        ws_max_unauthenticated_connections=100,
        ws_audio_queue_max_chunks=32,
        ws_max_audio_duration_ms=120000,
        openai_base_url="https://example.invalid/v1",
        openai_api_key="test-secret-key",
        openai_model="qwen-flash",
        openai_timeout_seconds=5.0,
        agent_max_tool_rounds=4,
    )


def text_chunk(content: object, finish_reason: object = None) -> object:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=content, tool_calls=None),
                finish_reason=finish_reason,
            )
        ],
        usage=None,
    )


def tool_chunk(
    *, index: object, call_id: object, name: object, arguments: object, finish_reason: object = None
) -> object:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=index,
                            id=call_id,
                            function=SimpleNamespace(name=name, arguments=arguments),
                        )
                    ],
                ),
                finish_reason=finish_reason,
            )
        ],
        usage=None,
    )


def usage_chunk(prompt: object = 1, completion: object = 2, total: object = 3) -> object:
    return SimpleNamespace(
        choices=[],
        usage=SimpleNamespace(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=total,
        ),
    )


@pytest.mark.asyncio
async def test_stream_sends_documented_request_shape() -> None:
    stream = FakeStream([text_chunk(None, "stop"), usage_chunk()])
    client = FakeClient(stream)
    provider = OpenAICompatibleLlm(settings(), client=client)
    messages = [
        ChatMessage(role="system", content="system"),
        ChatMessage(role="user", content="hello"),
        AssistantToolCallMessage(
            content="",
            tool_calls=(ToolCall("call_1", "schedule_query", '{"title":"会议"}'),),
        ),
        ToolResultMessage(tool_call_id="call_1", content='{"status":"not_implemented"}'),
    ]
    tools = [
        ToolDefinition(
            name="schedule_query",
            description="查询日程",
            parameters={"type": "object", "additionalProperties": True},
        )
    ]

    events = [event async for event in provider.stream(messages, tools)]

    request = client.chat.completions.requests[0]
    assert request == {
        "model": "qwen-flash",
        "messages": [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "hello"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "schedule_query",
                            "arguments": '{"title":"会议"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": '{"status":"not_implemented"}',
            },
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "schedule_query",
                    "description": "查询日程",
                    "parameters": {"type": "object", "additionalProperties": True},
                },
            }
        ],
        "stream": True,
        "stream_options": {"include_usage": True},
        "extra_body": {"enable_thinking": False},
        "parallel_tool_calls": False,
        "tool_choice": "auto",
    }
    assert events == [LlmStreamCompleted("stop", LlmUsage(1, 2, 3))]
    assert stream.closed is True


@pytest.mark.asyncio
async def test_text_tool_and_usage_chunks_are_mapped() -> None:
    stream = FakeStream(
        [
            text_chunk("你好"),
            text_chunk(""),
            text_chunk(None),
            tool_chunk(
                index=0,
                call_id="call_1",
                name="schedule_create",
                arguments='{"title":"',
            ),
            tool_chunk(
                index=0,
                call_id=None,
                name=None,
                arguments='开会"}',
                finish_reason="tool_calls",
            ),
            usage_chunk(3, 4, 7),
        ]
    )
    provider = OpenAICompatibleLlm(settings(), client=FakeClient(stream))

    events = [
        event async for event in provider.stream([ChatMessage(role="user", content="创建日程")], [])
    ]

    assert events == [
        TextDelta("你好"),
        ToolCallDelta(0, "call_1", "schedule_create", '{"title":"'),
        ToolCallDelta(0, None, None, '开会"}'),
        LlmStreamCompleted("tool_calls", LlmUsage(3, 4, 7)),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunk",
    [
        text_chunk(123),
        text_chunk("ok", finish_reason=123),
        tool_chunk(index="0", call_id="call_1", name="tool", arguments="{}"),
        tool_chunk(index=0, call_id=123, name="tool", arguments="{}"),
        tool_chunk(index=0, call_id="call_1", name=123, arguments="{}"),
        tool_chunk(index=0, call_id="call_1", name="tool", arguments=123),
        usage_chunk(-1, 2, 1),
    ],
)
async def test_invalid_known_chunk_fields_raise_protocol_error(chunk: object) -> None:
    provider = OpenAICompatibleLlm(settings(), client=FakeClient(FakeStream([chunk])))

    with pytest.raises(LlmProtocolError):
        _ = [
            event
            async for event in provider.stream([ChatMessage(role="user", content="hello")], [])
        ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("openai_base_url", "OpenAI-compatible base URL is not configured"),
        ("openai_api_key", "OpenAI-compatible API key is not configured"),
        ("openai_model", "OpenAI-compatible model is not configured"),
    ],
)
async def test_missing_settings_fail_when_stream_is_consumed(field: str, message: str) -> None:
    provider = OpenAICompatibleLlm(
        replace(settings(), **{field: ""}),
        client=FakeClient(FakeStream([])),
    )

    with pytest.raises(LlmProviderError, match=message):
        _ = [
            event
            async for event in provider.stream([ChatMessage(role="user", content="hello")], [])
        ]


@pytest.mark.asyncio
async def test_request_failure_is_provider_error_without_api_key() -> None:
    provider = OpenAICompatibleLlm(
        settings(),
        client=FakeClient(RuntimeError("request failed with test-secret-key")),
    )

    with pytest.raises(LlmProviderError) as captured:
        _ = [
            event
            async for event in provider.stream([ChatMessage(role="user", content="hello")], [])
        ]

    assert "test-secret-key" not in str(captured.value)


@pytest.mark.asyncio
async def test_cancellation_closes_stream_and_propagates() -> None:
    stream = BlockingFakeStream()
    provider = OpenAICompatibleLlm(settings(), client=FakeClient(stream))

    async def consume() -> None:
        _ = [
            event
            async for event in provider.stream([ChatMessage(role="user", content="hello")], [])
        ]

    task = asyncio.create_task(consume())
    await stream.started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert stream.closed is True
