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
    AgentSessionEnd,
    AgentTextDelta,
    AgentToolError,
    AgentToolRoundLimitError,
    AgentTurnTiming,
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
    payload: dict[str, object] = {
        "question_kind": question_kind,
        "speech_text": speech_text,
        "required_response": required_response,
    }
    if candidates is not None:
        payload["candidates"] = candidates
    arguments = json.dumps(payload, ensure_ascii=False)
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
async def test_final_round_text_is_streamed_before_completion() -> None:
    """The final-answer round yields text as it streams, not after the round ends."""
    release = asyncio.Event()

    class GatedLlm:
        def __init__(self) -> None:
            self.requests: list[tuple[tuple[LlmMessage, ...], tuple[ToolDefinition, ...]]] = []

        def stream(
            self,
            messages: Sequence[LlmMessage],
            tools: Sequence[ToolDefinition],
        ) -> AsyncIterator[LlmEvent]:
            self.requests.append((tuple(messages), tuple(tools)))
            round_index = len(self.requests)

            async def generate() -> AsyncIterator[LlmEvent]:
                if round_index == 1:
                    yield ToolCallDelta(0, "call_1", "schedule_create", "{}")
                    yield LlmStreamCompleted("tool_calls", LlmUsage(1, 1, 2))
                else:
                    yield TextDelta("已创建")
                    await release.wait()
                    yield LlmStreamCompleted("stop", LlmUsage(2, 2, 4))

            return generate()

    tool = RecordingTool(ToolDefinition("schedule_create", "创建日程", {"type": "object"}))
    agent = Agent(GatedLlm(), ToolRegistry([tool]))

    generator = agent.run_turn(AgentConversation(), "创建日程")

    # The first yielded event is the final-round text, delivered while the stream is
    # still blocked on the gate. A buffering implementation would hang here waiting for
    # the round to complete before yielding anything.
    first = await generator.__anext__()
    assert first == AgentTextDelta("已创建")
    assert not release.is_set()

    release.set()
    remaining = [event async for event in generator]
    assert remaining == [AgentCompleted(LlmUsage(3, 3, 6))]


class ScriptedClock:
    """Return scripted monotonic values in order and fail on extra calls."""

    def __init__(self, *values: float) -> None:
        self._values = iter(values)

    def __call__(self) -> float:
        return next(self._values)


@pytest.mark.asyncio
async def test_completed_reports_tool_turn_phase_timing() -> None:
    """A tool turn splits its wall-clock into tool-call, execution, and text phases."""
    tool = RecordingTool(
        ToolDefinition("schedule_create", "创建日程", {"type": "object"}),
        result='{"status":"ok"}',
    )
    llm = FakeLlm(
        [
            tool_events("schedule_create", '{"title":"开会"}'),
            [TextDelta("已创建。"), completed()],
        ]
    )
    agent = Agent(
        llm,
        ToolRegistry([tool]),
        monotonic=ScriptedClock(0.0, 0.5, 1.0, 1.5, 2.0, 2.5),
    )

    events = [event async for event in agent.run_turn(AgentConversation(), "创建开会日程")]

    completed_event = events[-1]
    assert isinstance(completed_event, AgentCompleted)
    assert completed_event.timing == AgentTurnTiming(500.0, 500.0, 500.0)


@pytest.mark.asyncio
async def test_completed_reports_text_only_turn_timing() -> None:
    """A turn without a tool call reports zero tool-call and execution time."""
    llm = FakeLlm([[TextDelta("你好。"), completed()]])
    agent = Agent(llm, ToolRegistry([]), monotonic=ScriptedClock(0.0, 0.5))

    events = [event async for event in agent.run_turn(AgentConversation(), "你好")]

    completed_event = events[-1]
    assert isinstance(completed_event, AgentCompleted)
    assert completed_event.timing == AgentTurnTiming(0.0, 0.0, 500.0)


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
    "bad_events",
    [
        question_events(question_kind="invalid"),
        question_events(speech_text=""),
        question_events(required_response=""),
        question_events(candidates=[1]),
        question_events(question_kind="ambiguous_target", candidates=[]),
        question_events(question_kind="recurrence_scope", candidates=[1]),
    ],
)
async def test_invalid_question_is_refused_and_model_retries(
    bad_events: Sequence[LlmEvent],
) -> None:
    llm = FakeLlm([bad_events, [TextDelta("好的。"), completed()]])
    conversation = AgentConversation()
    agent = Agent(
        llm, ToolRegistry([RecordingTool(request_user_input_definition())]), max_tool_rounds=4
    )

    events = [event async for event in agent.run_turn(conversation, "test")]

    assert events == [AgentTextDelta("好的。"), AgentCompleted(LlmUsage(4, 3, 7))]
    assert conversation.pending_question is None
    assert isinstance(conversation.messages[-2], ToolResultMessage)
    assert '"status":"failed"' in conversation.messages[-2].content
    assert conversation.messages[-1] == ChatMessage(role="assistant", content="好的。")


@pytest.mark.asyncio
async def test_ambiguous_target_without_candidates_refusal_names_schedule_query() -> None:
    llm = FakeLlm([question_events(question_kind="ambiguous_target", candidates=[]), [completed()]])
    conversation = AgentConversation()
    agent = Agent(
        llm, ToolRegistry([RecordingTool(request_user_input_definition())]), max_tool_rounds=4
    )

    _ = [event async for event in agent.run_turn(conversation, "test")]

    refusal = conversation.messages[-2]
    assert isinstance(refusal, ToolResultMessage)
    assert "schedule_query" in refusal.content


@pytest.mark.asyncio
async def test_end_conversation_streams_farewell_before_terminal_events() -> None:
    events = [
        TextDelta("再见。"),
        *tool_events("end_conversation", "{}", "end_1"),
    ]
    conversation = AgentConversation()
    agent = Agent(FakeLlm([events]), ToolRegistry([]))

    delivered = [event async for event in agent.run_turn(conversation, "先这样")]

    assert delivered == [
        AgentTextDelta("再见。"),
        AgentSessionEnd(),
        AgentCompleted(DEFAULT_TOOL_USAGE),
    ]
    assert isinstance(conversation.messages[-1], AssistantToolCallMessage)
    assert conversation.messages[-1].content == "再见。"


@pytest.mark.asyncio
async def test_end_conversation_rejects_non_empty_arguments() -> None:
    conversation = AgentConversation()
    agent = Agent(
        FakeLlm([tool_events("end_conversation", '{"reason":"done"}', "end_1")]),
        ToolRegistry([]),
    )

    with pytest.raises(AgentToolError, match="arguments must be empty"):
        _ = [event async for event in agent.run_turn(conversation, "结束")]

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
