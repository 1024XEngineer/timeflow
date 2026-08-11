"""Serial Agent function-calling behavior tests."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field

import pytest

from timeflow.intelligence.conversation.agent import (
    Agent,
    AgentCompleted,
    AgentConversation,
    AgentProtocolError,
    AgentQuestion,
    AgentTextDelta,
    AgentToolError,
    AgentToolRoundLimitError,
)
from timeflow.intelligence.conversation.llm import (
    AssistantToolCallMessage,
    ChatMessage,
    LlmEvent,
    LlmMessage,
    LlmStreamCompleted,
    LlmUsage,
    TextDelta,
    ToolCallDelta,
    ToolDefinition,
    ToolResultMessage,
)
from timeflow.intelligence.conversation.tools import (
    ToolRegistry,
    request_user_input_definition,
)


class FakeLlm:
    def __init__(self, responses: Sequence[Sequence[LlmEvent] | BaseException]) -> None:
        self._responses = list(responses)
        self.requests: list[tuple[tuple[LlmMessage, ...], tuple[ToolDefinition, ...]]] = []

    def stream(
        self,
        messages: Sequence[LlmMessage],
        tools: Sequence[ToolDefinition],
    ) -> AsyncIterator[LlmEvent]:
        self.requests.append((tuple(messages), tuple(tools)))
        if not self._responses:
            raise AssertionError("FakeLlm received more requests than expected")
        response = self._responses.pop(0)

        async def generate() -> AsyncIterator[LlmEvent]:
            if isinstance(response, BaseException):
                raise response
            for event in response:
                yield event

        return generate()


@dataclass(slots=True)
class RecordingTool:
    definition: ToolDefinition
    result: object = '{"status":"not_implemented"}'
    calls: list[Mapping[str, object]] = field(default_factory=list)
    error: Exception | None = None

    async def execute(self, arguments: Mapping[str, object]) -> str:
        self.calls.append(arguments)
        if self.error is not None:
            raise self.error
        return self.result  # type: ignore[return-value]


def completed(prompt: int = 1, completion: int = 2, total: int = 3) -> LlmStreamCompleted:
    return LlmStreamCompleted("stop", LlmUsage(prompt, completion, total))


DEFAULT_TOOL_USAGE = LlmUsage(3, 1, 4)


def tool_events(
    name: str = "schedule_create",
    arguments: str = '{"title":"开会"}',
    call_id: str | None = "call_1",
    index: int = 0,
    usage: LlmUsage | None = DEFAULT_TOOL_USAGE,
) -> list[LlmEvent]:
    return [
        ToolCallDelta(index, call_id, name, arguments),
        LlmStreamCompleted("tool_calls", usage),
    ]


def question_events(
    *,
    call_id: str = "question_1",
    question_kind: object = "missing_field",
    speech_text: object = "你想什么时候开会？",
    required_response: object = "start_time",
    candidates: object = None,
) -> list[LlmEvent]:
    arguments = json.dumps(
        {
            "question_kind": question_kind,
            "speech_text": speech_text,
            "required_response": required_response,
            "candidates": [] if candidates is None else candidates,
        },
        ensure_ascii=False,
    )
    return tool_events("request_user_input", arguments, call_id)


@pytest.mark.asyncio
async def test_run_turn_streams_text_and_completion_without_tools() -> None:
    llm = FakeLlm([[TextDelta("你好"), TextDelta("，我可以帮你"), completed()]])
    conversation = AgentConversation()
    agent = Agent(llm, ToolRegistry([]), max_tool_rounds=4)

    events = [event async for event in agent.run_turn(conversation, "你好")]

    assert events == [
        AgentTextDelta("你好"),
        AgentTextDelta("，我可以帮你"),
        AgentCompleted(LlmUsage(1, 2, 3)),
    ]
    assert isinstance(conversation.messages[0], ChatMessage)
    assert conversation.messages[0].role == "system"
    assert conversation.messages[1] == ChatMessage(role="user", content="你好")
    assert conversation.messages[2] == ChatMessage(role="assistant", content="你好，我可以帮你")


@pytest.mark.asyncio
async def test_followup_request_includes_previous_assistant_response() -> None:
    llm = FakeLlm(
        [
            [TextDelta("第一轮回答。"), completed()],
            [TextDelta("第二轮回答。"), completed()],
        ]
    )
    conversation = AgentConversation()
    agent = Agent(llm, ToolRegistry([]))

    _ = [event async for event in agent.run_turn(conversation, "第一轮问题")]
    _ = [event async for event in agent.run_turn(conversation, "继续说明")]

    second_messages, _ = llm.requests[1]
    assert second_messages == (
        conversation.messages[0],
        ChatMessage(role="user", content="第一轮问题"),
        ChatMessage(role="assistant", content="第一轮回答。"),
        ChatMessage(role="user", content="继续说明"),
    )
    assert conversation.messages[-1] == ChatMessage(role="assistant", content="第二轮回答。")


@pytest.mark.asyncio
async def test_tool_round_text_is_not_exposed_as_agent_text_delta() -> None:
    tool = RecordingTool(
        ToolDefinition("schedule_create", "创建日程", {"type": "object"}),
        result='{"status":"not_implemented"}',
    )
    llm = FakeLlm(
        [
            [
                TextDelta("我先处理一下。"),
                ToolCallDelta(0, "call_1", "schedule_create", "{}"),
                completed(),
            ],
            [TextDelta("日程服务尚未接入。"), completed()],
        ]
    )

    events = [
        event
        async for event in Agent(llm, ToolRegistry([tool])).run_turn(
            AgentConversation(), "创建日程"
        )
    ]

    assert events == [
        AgentTextDelta("日程服务尚未接入。"),
        AgentCompleted(LlmUsage(2, 4, 6)),
    ]

    tool = RecordingTool(
        ToolDefinition(
            "schedule_create",
            "创建日程",
            {"type": "object", "additionalProperties": True},
        ),
        result='{"status":"not_implemented","tool":"schedule_create"}',
    )
    llm = FakeLlm(
        [
            [
                ToolCallDelta(0, "call_1", "schedule_create", '{"title":"'),
                ToolCallDelta(0, None, None, '开会"}'),
                LlmStreamCompleted("tool_calls", LlmUsage(3, 1, 4)),
            ],
            [TextDelta("日程服务尚未接入。"), completed(5, 2, 7)],
        ]
    )
    conversation = AgentConversation()
    agent = Agent(llm, ToolRegistry([tool]), max_tool_rounds=4)

    events = [event async for event in agent.run_turn(conversation, "创建开会日程")]

    assert tool.calls == [{"title": "开会"}]
    assert events == [
        AgentTextDelta("日程服务尚未接入。"),
        AgentCompleted(LlmUsage(8, 3, 11)),
    ]
    assert isinstance(conversation.messages[-3], AssistantToolCallMessage)
    assert conversation.messages[-2] == ToolResultMessage(
        tool_call_id="call_1",
        content='{"status":"not_implemented","tool":"schedule_create"}',
    )
    assert conversation.messages[-1] == ChatMessage(role="assistant", content="日程服务尚未接入。")
    assert llm.requests[1][0][-1] == conversation.messages[-2]


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", ["{bad", "[]"])
async def test_invalid_arguments_do_not_execute_tool(arguments: str) -> None:
    tool = RecordingTool(ToolDefinition("schedule_create", "", {"type": "object"}))
    conversation = AgentConversation()
    agent = Agent(FakeLlm([tool_events(arguments=arguments)]), ToolRegistry([tool]))

    with pytest.raises(AgentToolError):
        _ = [event async for event in agent.run_turn(conversation, "create")]

    assert tool.calls == []
    assert not any(isinstance(message, ToolResultMessage) for message in conversation.messages)


@pytest.mark.asyncio
async def test_unknown_tool_is_rejected() -> None:
    agent = Agent(FakeLlm([tool_events(name="unknown")]), ToolRegistry([]))

    with pytest.raises(AgentToolError, match="Unknown Agent tool: unknown"):
        _ = [event async for event in agent.run_turn(AgentConversation(), "test")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "events",
    [
        tool_events(call_id=None),
        [ToolCallDelta(0, "call_1", None, "{}"), completed()],
        [
            ToolCallDelta(0, "call_1", "schedule_create", "{}"),
            ToolCallDelta(0, "call_2", None, ""),
            completed(),
        ],
        [
            ToolCallDelta(0, "call_1", "schedule_create", "{}"),
            ToolCallDelta(0, None, "schedule_delete", ""),
            completed(),
        ],
    ],
)
async def test_incomplete_or_conflicting_calls_are_protocol_errors(
    events: Sequence[LlmEvent],
) -> None:
    with pytest.raises(AgentProtocolError):
        _ = [
            event
            async for event in Agent(
                FakeLlm([events]), ToolRegistry([RecordingTool(request_user_input_definition())])
            ).run_turn(AgentConversation(), "test")
        ]


@pytest.mark.asyncio
async def test_multiple_calls_are_rejected_before_execution() -> None:
    first = RecordingTool(ToolDefinition("first", "", {"type": "object"}))
    second = RecordingTool(ToolDefinition("second", "", {"type": "object"}))
    llm = FakeLlm(
        [
            [
                ToolCallDelta(0, "call_1", "first", "{}"),
                ToolCallDelta(1, "call_2", "second", "{}"),
                completed(),
            ]
        ]
    )

    with pytest.raises(AgentProtocolError, match="Parallel"):
        _ = [
            event
            async for event in Agent(llm, ToolRegistry([first, second])).run_turn(
                AgentConversation(), "test"
            )
        ]

    assert first.calls == []
    assert second.calls == []


@pytest.mark.asyncio
async def test_tool_failure_is_sanitized() -> None:
    tool = RecordingTool(
        ToolDefinition("schedule_create", "", {"type": "object"}),
        error=RuntimeError("secret arguments"),
    )
    agent = Agent(FakeLlm([tool_events()]), ToolRegistry([tool]))

    with pytest.raises(AgentToolError) as captured:
        _ = [event async for event in agent.run_turn(AgentConversation(), "test")]

    assert "secret arguments" not in str(captured.value)
    assert "开会" not in str(captured.value)


@pytest.mark.asyncio
async def test_non_string_tool_result_is_rejected() -> None:
    tool = RecordingTool(
        ToolDefinition("schedule_create", "", {"type": "object"}),
        result={"bad": True},
    )
    agent = Agent(FakeLlm([tool_events()]), ToolRegistry([tool]))

    with pytest.raises(AgentToolError, match="non-string"):
        _ = [event async for event in agent.run_turn(AgentConversation(), "test")]


@pytest.mark.asyncio
async def test_fifth_tool_call_is_blocked() -> None:
    tool = RecordingTool(ToolDefinition("schedule_create", "", {"type": "object"}))
    llm = FakeLlm([tool_events(call_id=f"call_{index}") for index in range(5)])
    agent = Agent(llm, ToolRegistry([tool]), max_tool_rounds=4)

    with pytest.raises(AgentToolRoundLimitError):
        _ = [event async for event in agent.run_turn(AgentConversation(), "test")]

    assert len(tool.calls) == 4


@pytest.mark.asyncio
async def test_missing_usage_makes_completed_usage_unknown() -> None:
    tool = RecordingTool(ToolDefinition("schedule_create", "", {"type": "object"}))
    llm = FakeLlm([tool_events(usage=None), [completed()]])

    events = [
        event
        async for event in Agent(llm, ToolRegistry([tool])).run_turn(AgentConversation(), "test")
    ]

    assert events == [AgentCompleted(None)]


@pytest.mark.asyncio
async def test_empty_text_completion_records_assistant_turn() -> None:
    conversation = AgentConversation()
    events = [
        event
        async for event in Agent(FakeLlm([[completed()]]), ToolRegistry([])).run_turn(
            conversation, "你好"
        )
    ]

    assert events == [AgentCompleted(LlmUsage(1, 2, 3))]
    assert conversation.messages[-1] == ChatMessage(role="assistant", content="")
    agent = Agent(FakeLlm([[TextDelta("partial")]]), ToolRegistry([]))

    with pytest.raises(AgentProtocolError, match="without a completion"):
        _ = [event async for event in agent.run_turn(AgentConversation(), "test")]


@pytest.mark.asyncio
async def test_request_user_input_saves_question_and_stops_turn() -> None:
    llm = FakeLlm([question_events()])
    conversation = AgentConversation()
    agent = Agent(
        llm, ToolRegistry([RecordingTool(request_user_input_definition())]), max_tool_rounds=4
    )

    events = [event async for event in agent.run_turn(conversation, "提醒我开会")]

    assert events == [
        AgentQuestion(
            question_kind="missing_field",
            speech_text="你想什么时候开会？",
            required_response="start_time",
            candidates=(),
        )
    ]
    assert conversation.pending_question is not None
    assert conversation.pending_question.tool_call_id == "question_1"
    assert isinstance(conversation.messages[-1], AssistantToolCallMessage)
    assert len(llm.requests) == 1


@pytest.mark.asyncio
async def test_pending_answer_becomes_tool_result_without_duplicate_user_message() -> None:
    llm = FakeLlm(
        [
            question_events(),
            [TextDelta("好的。"), completed(2, 1, 3)],
        ]
    )
    conversation = AgentConversation()
    agent = Agent(
        llm, ToolRegistry([RecordingTool(request_user_input_definition())]), max_tool_rounds=4
    )
    _ = [event async for event in agent.run_turn(conversation, "提醒我开会")]

    events = [event async for event in agent.run_turn(conversation, "明天下午三点")]

    assert events == [AgentTextDelta("好的。"), AgentCompleted(LlmUsage(2, 1, 3))]
    assert conversation.pending_question is None
    assert conversation.messages[-2] == ToolResultMessage(
        tool_call_id="question_1",
        content='{"user_response":"明天下午三点"}',
    )
    assert conversation.messages[-1] == ChatMessage(role="assistant", content="好的。")
    assert ChatMessage(role="user", content="明天下午三点") not in conversation.messages


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "events",
    [
        question_events(question_kind="invalid"),
        question_events(speech_text=""),
        question_events(required_response=""),
        question_events(candidates=[1]),
        question_events(question_kind="ambiguous_target", candidates=[]),
        question_events(question_kind="recurrence_scope", candidates=[]),
    ],
)
async def test_invalid_questions_do_not_pollute_conversation(events: Sequence[LlmEvent]) -> None:
    conversation = AgentConversation()
    agent = Agent(FakeLlm([events]), ToolRegistry([RecordingTool(request_user_input_definition())]))

    with pytest.raises(AgentToolError):
        _ = [event async for event in agent.run_turn(conversation, "test")]

    assert conversation.pending_question is None
    assert not any(
        isinstance(message, AssistantToolCallMessage) for message in conversation.messages
    )


@pytest.mark.asyncio
async def test_answer_can_be_followed_by_another_question() -> None:
    llm = FakeLlm(
        [
            question_events(),
            question_events(
                call_id="question_2",
                question_kind="confirmation",
                speech_text="确认创建吗？",
                required_response="confirmation",
            ),
        ]
    )
    conversation = AgentConversation()
    agent = Agent(llm, ToolRegistry([RecordingTool(request_user_input_definition())]))
    _ = [event async for event in agent.run_turn(conversation, "提醒我开会")]

    events = [event async for event in agent.run_turn(conversation, "明天下午三点")]

    assert events == [AgentQuestion("confirmation", "确认创建吗？", "confirmation", ())]
    assert conversation.pending_question is not None
    assert conversation.pending_question.tool_call_id == "question_2"


@pytest.mark.asyncio
async def test_conversations_keep_independent_pending_questions() -> None:
    llm = FakeLlm([question_events(call_id="a"), question_events(call_id="b")])
    agent = Agent(llm, ToolRegistry([RecordingTool(request_user_input_definition())]))
    first = AgentConversation()
    second = AgentConversation()

    _ = [event async for event in agent.run_turn(first, "first")]
    _ = [event async for event in agent.run_turn(second, "second")]

    assert first.pending_question is not None
    assert second.pending_question is not None
    assert first.pending_question.tool_call_id == "a"
    assert second.pending_question.tool_call_id == "b"


@pytest.mark.asyncio
async def test_pending_answer_is_stored_before_followup_failure() -> None:
    llm = FakeLlm([question_events(), RuntimeError("provider failed")])
    conversation = AgentConversation()
    agent = Agent(llm, ToolRegistry([RecordingTool(request_user_input_definition())]))
    _ = [event async for event in agent.run_turn(conversation, "提醒我开会")]

    with pytest.raises(RuntimeError, match="provider failed"):
        _ = [event async for event in agent.run_turn(conversation, "明天下午三点")]

    assert conversation.pending_question is None
    assert conversation.messages[-1] == ToolResultMessage(
        "question_1", '{"user_response":"明天下午三点"}'
    )


@pytest.mark.asyncio
async def test_cancellation_propagates_without_fake_messages() -> None:
    class CancellingLlm:
        def stream(
            self,
            messages: Sequence[LlmMessage],
            tools: Sequence[ToolDefinition],
        ) -> AsyncIterator[LlmEvent]:
            del messages, tools

            async def generate() -> AsyncIterator[LlmEvent]:
                raise asyncio.CancelledError
                yield completed()  # pragma: no cover

            return generate()

    conversation = AgentConversation()

    with pytest.raises(asyncio.CancelledError):
        _ = [
            event
            async for event in Agent(CancellingLlm(), ToolRegistry([])).run_turn(
                conversation, "test"
            )
        ]

    assert len(conversation.messages) == 2
