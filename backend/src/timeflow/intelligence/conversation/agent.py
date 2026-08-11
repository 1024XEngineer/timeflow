"""Serial Agent orchestration and conversation state."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Literal, TypeAlias, cast

from timeflow.intelligence.conversation.llm import (
    AssistantToolCallMessage,
    ChatMessage,
    LlmEvent,
    LlmMessage,
    LlmPort,
    LlmStreamCompleted,
    LlmUsage,
    TextDelta,
    ToolCall,
    ToolCallDelta,
    ToolResultMessage,
)
from timeflow.intelligence.conversation.tools import ToolRegistry

SYSTEM_PROMPT = """你是 TimeFlow 时间管理助手，帮助用户管理时间日程、地点日程和提醒。

必须通过工具执行创建、查询、修改和删除，不得仅凭文本声称操作成功；只有工具返回成功结果后才能告知用户成功。返回 error 或 not_implemented 时必须如实说明。不得编造日程 ID、revision、地点、地址、经纬度、候选项或业务结果。

创建时补齐必要信息；缺少信息调用 request_user_input，地点信息不完整调用 location_search。修改或删除前先查询并确认目标；多个候选必须反问，不能自行选择。删除必须获得明确确认，周期删除必须确认 this_occurrence、this_and_future 或 entire_series。

当前支持修改整个日程或整个周期系列，不支持只修改某一次周期发生实例；不得将后者错误地执行为整个周期修改。修改时未提及的字段保持原值。地点工具由系统处理默认搜索范围，不要猜测城市或把用户当前位置当作目标地点。相对时间使用系统提供的时间和时区。"""

QuestionKind: TypeAlias = Literal[
    "missing_field",
    "ambiguous_target",
    "recurrence_scope",
    "confirmation",
]
_ALLOWED_QUESTION_KINDS = {
    "missing_field",
    "ambiguous_target",
    "recurrence_scope",
    "confirmation",
}


@dataclass(frozen=True, slots=True)
class PendingQuestion:
    """A validated question waiting for the next user turn."""

    tool_call_id: str
    question_kind: QuestionKind
    speech_text: str
    required_response: str
    candidates: tuple[str, ...]


@dataclass(slots=True)
class AgentConversation:
    """In-memory conversation state explicitly owned by the caller."""

    messages: list[LlmMessage] = field(default_factory=list)
    pending_question: PendingQuestion | None = None


@dataclass(frozen=True, slots=True)
class AgentTextDelta:
    """A text increment ready for downstream streaming."""

    text: str


@dataclass(frozen=True, slots=True)
class AgentQuestion:
    """A structured question that pauses the current turn."""

    question_kind: QuestionKind
    speech_text: str
    required_response: str
    candidates: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AgentCompleted:
    """The terminal event for a completed Agent turn."""

    usage: LlmUsage | None


AgentEvent: TypeAlias = AgentTextDelta | AgentQuestion | AgentCompleted


class AgentError(Exception):
    """Base class for Agent failures."""


class AgentProtocolError(AgentError):
    """The model output or conversation state is unsupported or invalid."""


class AgentToolError(AgentError):
    """Tool lookup, arguments, or execution failed."""


class AgentToolRoundLimitError(AgentError):
    """The configured tool round limit was exceeded."""


@dataclass(slots=True)
class _ToolCallAccumulator:
    call_id: str | None = None
    name: str | None = None
    argument_parts: list[str] = field(default_factory=list)

    def add(self, delta: ToolCallDelta) -> None:
        if delta.call_id is not None:
            if self.call_id is not None and self.call_id != delta.call_id:
                raise AgentProtocolError("Conflicting Agent tool call IDs")
            self.call_id = delta.call_id
        if delta.name is not None:
            if self.name is not None and self.name != delta.name:
                raise AgentProtocolError("Conflicting Agent tool names")
            self.name = delta.name
        self.argument_parts.append(delta.arguments)


@dataclass(slots=True)
class _TurnResponse:
    text_parts: list[str] = field(default_factory=list)
    tool_calls: dict[int, _ToolCallAccumulator] = field(default_factory=dict)
    completed: LlmStreamCompleted | None = None


class Agent:
    """Run serial provider-neutral Function Calling turns."""

    def __init__(self, llm: LlmPort, tools: ToolRegistry, max_tool_rounds: int = 4) -> None:
        if max_tool_rounds <= 0:
            raise ValueError("max_tool_rounds must be positive")
        self._llm = llm
        self._tools = tools
        self._max_tool_rounds = max_tool_rounds

    def run_turn(
        self,
        conversation: AgentConversation,
        user_text: str,
    ) -> AsyncIterator[AgentEvent]:
        """Process one user turn, pausing if structured input is required."""
        return self._run_turn(conversation, user_text)

    async def _run_turn(
        self,
        conversation: AgentConversation,
        user_text: str,
    ) -> AsyncIterator[AgentEvent]:
        self._prepare_turn(conversation, user_text)
        tool_rounds = 0
        usages: list[LlmUsage] = []
        usage_complete = True

        while True:
            response = await self._collect_response(conversation)
            completed = response.completed
            if completed is None:
                raise AgentProtocolError("LLM stream ended without a completion event")
            if completed.usage is None:
                usage_complete = False
            else:
                usages.append(completed.usage)

            if not response.tool_calls:
                conversation.messages.append(
                    ChatMessage(role="assistant", content="".join(response.text_parts))
                )
                for text in response.text_parts:
                    yield AgentTextDelta(text)
                yield AgentCompleted(_sum_usage(usages) if usage_complete else None)
                return
            if len(response.tool_calls) != 1:
                raise AgentProtocolError("Parallel Agent tool calls are not supported")
            if tool_rounds >= self._max_tool_rounds:
                raise AgentToolRoundLimitError("Agent tool round limit exceeded")

            accumulator = next(iter(response.tool_calls.values()))
            tool_call = _complete_tool_call(accumulator)
            arguments = _parse_tool_arguments(tool_call.arguments)
            assistant_message = AssistantToolCallMessage(
                content="".join(response.text_parts),
                tool_calls=(tool_call,),
            )
            tool_rounds += 1

            if tool_call.name == "request_user_input":
                pending = _pending_question_from_arguments(tool_call.call_id, arguments)
                conversation.messages.append(assistant_message)
                conversation.pending_question = pending
                yield AgentQuestion(
                    pending.question_kind,
                    pending.speech_text,
                    pending.required_response,
                    pending.candidates,
                )
                return

            try:
                tool = self._tools.get(tool_call.name)
            except KeyError as exc:
                raise AgentToolError(f"Unknown Agent tool: {tool_call.name}") from exc
            try:
                result = await tool.execute(arguments)
            except Exception as exc:
                raise AgentToolError(f"Agent tool execution failed: {tool_call.name}") from exc
            if not isinstance(result, str):
                raise AgentToolError(f"Agent tool returned a non-string result: {tool_call.name}")

            conversation.messages.extend(
                [
                    assistant_message,
                    ToolResultMessage(tool_call_id=tool_call.call_id, content=result),
                ]
            )

    async def _collect_response(self, conversation: AgentConversation) -> _TurnResponse:
        response = _TurnResponse()
        async for event in self._llm.stream(
            conversation.messages,
            self._tools.definitions(),
        ):
            if isinstance(event, TextDelta):
                response.text_parts.append(event.text)
            elif isinstance(event, ToolCallDelta):
                response.tool_calls.setdefault(event.index, _ToolCallAccumulator()).add(event)
            elif isinstance(event, LlmStreamCompleted):
                if response.completed is not None:
                    raise AgentProtocolError("LLM stream completed more than once")
                response.completed = event
            else:
                raise AgentProtocolError("Unsupported LLM stream event")
        return response

    @staticmethod
    def _prepare_turn(conversation: AgentConversation, user_text: str) -> None:
        if not conversation.messages:
            conversation.messages.append(ChatMessage(role="system", content=SYSTEM_PROMPT))
        elif not isinstance(conversation.messages[0], ChatMessage) or (
            conversation.messages[0].role != "system"
        ):
            raise AgentProtocolError("Agent conversation must begin with a system message")

        pending = conversation.pending_question
        if pending is None:
            conversation.messages.append(ChatMessage(role="user", content=user_text))
            return

        answer = json.dumps(
            {"user_response": user_text},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        conversation.messages.append(
            ToolResultMessage(tool_call_id=pending.tool_call_id, content=answer)
        )
        conversation.pending_question = None

    @staticmethod
    def _collect_llm_event(
        event: LlmEvent,
        accumulators: dict[int, _ToolCallAccumulator],
        assistant_content: list[str],
    ) -> None:
        if isinstance(event, TextDelta):
            assistant_content.append(event.text)
        elif isinstance(event, ToolCallDelta):
            accumulators.setdefault(event.index, _ToolCallAccumulator()).add(event)
        elif not isinstance(event, LlmStreamCompleted):
            raise AgentProtocolError("Unsupported LLM stream event")


def _complete_tool_call(accumulator: _ToolCallAccumulator) -> ToolCall:
    if not accumulator.call_id:
        raise AgentProtocolError("Agent tool call ID is missing")
    if not accumulator.name:
        raise AgentProtocolError("Agent tool call name is missing")
    return ToolCall(
        call_id=accumulator.call_id,
        name=accumulator.name,
        arguments="".join(accumulator.argument_parts),
    )


def _parse_tool_arguments(raw_arguments: str) -> dict[str, object]:
    try:
        arguments = json.loads(raw_arguments)
    except json.JSONDecodeError as exc:
        raise AgentToolError("Agent tool arguments are not valid JSON") from exc
    if not isinstance(arguments, dict):
        raise AgentToolError("Agent tool arguments must be a JSON object")
    return cast(dict[str, object], arguments)


def _pending_question_from_arguments(
    tool_call_id: str,
    arguments: Mapping[str, object],
) -> PendingQuestion:
    question_kind = arguments.get("question_kind")
    speech_text = arguments.get("speech_text")
    required_response = arguments.get("required_response")
    candidates = arguments.get("candidates")
    if question_kind not in _ALLOWED_QUESTION_KINDS:
        raise AgentToolError("Invalid request_user_input question kind")
    if not isinstance(speech_text, str) or not speech_text.strip():
        raise AgentToolError("request_user_input speech_text must be non-empty")
    if not isinstance(required_response, str) or not required_response.strip():
        raise AgentToolError("request_user_input required_response must be non-empty")
    if not isinstance(candidates, list) or not all(isinstance(item, str) for item in candidates):
        raise AgentToolError("request_user_input candidates must be a list of strings")
    if question_kind in {"ambiguous_target", "recurrence_scope"} and not candidates:
        raise AgentToolError("request_user_input candidates are required for this question")
    return PendingQuestion(
        tool_call_id=tool_call_id,
        question_kind=cast(QuestionKind, question_kind),
        speech_text=speech_text,
        required_response=required_response,
        candidates=tuple(candidates),
    )


def _sum_usage(usages: list[LlmUsage]) -> LlmUsage:
    return LlmUsage(
        prompt_tokens=sum(usage.prompt_tokens for usage in usages),
        completion_tokens=sum(usage.completion_tokens for usage in usages),
        total_tokens=sum(usage.total_tokens for usage in usages),
    )
