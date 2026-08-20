"""Serial Agent orchestration and conversation state."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, TypeAlias, cast
from zoneinfo import ZoneInfo

from timeflow.intelligence.conversation.llm import (
    AssistantToolCallMessage,
    ChatMessage,
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

SYSTEM_PROMPT = """你是 TimeFlow 时间管理助手，帮助用户通过简短自然的语音对话管理日程和提醒。

语言与口吻：始终使用中文纯文本，像日常对话一样简短自然，通常一句话说完。不要客套，不要复述用户原话，不要使用 Markdown、标题、编号、项目符号或一次罗列多项信息。

必须通过工具执行创建、查询、修改和删除，不得仅凭文本声称操作成功；只有工具返回成功结果后才能告知用户成功。返回 error 或 not_implemented 时必须如实说明。不得编造日程 ID、revision、地点、地址、经纬度、候选项或业务结果。

信息不足时必须调用 request_user_input，不要直接输出普通文本让用户补充。每轮只能询问一个最关键的缺失信息；即使缺少多项，也要按多轮逐项引导，用户回答后再询问下一项。优先询问时间或地点等决定日程是否可执行的信息；标题可以结合用户表达推断，无法推断时再单独询问。schedule_type（时间型/地点型）和 schedule_kind（单次/重复）是内部字段，绝不要向用户提问或提及；用户提到具体地点就判为地点型，没提地点判为时间型，没说要重复判为单次，不要为此反问。speech_text 只包含当前这个简短问题，不要加“请提供以下信息”、示例、解释或其他待补字段。

写入 title 字段时必须改写为简洁的名词短语，适合客户端提醒文案直接展示：去掉「我」「帮我」「提醒我」「记一下」等第一人称或祈使开头，不要把时间、地点塞进标题（它们属于 start_time、location_name 等字段），例如「帮我明天下午三点开会」的 title 写成「开会」。创建时补齐其余必要信息；地点信息不完整调用 location_search。修改或删除前先查询并确认目标；多个候选必须反问，不能自行选择；用户指代不明（如「那个会」）或匹配到多条日程时，先用 schedule_query 查询，再把查到的候选放进 request_user_input 的 candidates。删除前必须先调用 request_user_input，question_kind 用 confirmation，把要删的那条（标题加时间）说清楚让用户确认；用户明确确认后，才调用 schedule_delete 真正删除。周期删除还需确认 this_occurrence、this_and_future 或 entire_series。

当前支持修改整个日程或整个周期系列，不支持只修改某一次周期发生实例；不得将后者错误地执行为整个周期修改。修改时未提及的字段保持原值。地点工具由系统处理默认搜索范围，不要猜测城市或把用户当前位置当作目标地点。相对时间使用系统提供的时间和时区。用户明确想结束连续语音对话时调用 end_conversation。"""

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
    required_response: str | None
    candidates: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class AgentTurnContext:
    """Dynamic time context supplied once for an Agent turn."""

    now: datetime
    timezone: str

    def system_message(self) -> str:
        """Describe the same instant in UTC and the session's local timezone."""
        local = self.now.astimezone(ZoneInfo(self.timezone))
        utc = self.now.astimezone(ZoneInfo("UTC"))
        return (
            f"当前 UTC 时间：{utc.isoformat()}。"
            f"当前本地时间：{local.isoformat()}。"
            f"当前 IANA 时区：{self.timezone}。"
        )


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
    required_response: str | None
    candidates: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class AgentSessionEnd:
    """The user asked the client to end the current voice session."""


@dataclass(frozen=True, slots=True)
class AgentTurnTiming:
    """Wall-clock phase breakdown for one Agent turn, in milliseconds.

    ``llm_tool_call_ms`` covers LLM rounds that produced tool calls,
    ``tool_execution_ms`` covers executing those tools, and ``llm_final_text_ms``
    covers the LLM round that produced the spoken reply. A turn with no tool call
    reports the first two as zero.
    """

    llm_tool_call_ms: float
    tool_execution_ms: float
    llm_final_text_ms: float


@dataclass(frozen=True, slots=True)
class AgentCompleted:
    """The terminal event for a completed Agent turn."""

    usage: LlmUsage | None
    timing: AgentTurnTiming | None = field(default=None, compare=False)


AgentEvent: TypeAlias = AgentTextDelta | AgentQuestion | AgentSessionEnd | AgentCompleted


class AgentError(Exception):
    """Base class for Agent failures."""


class AgentProtocolError(AgentError):
    """The model output or conversation state is unsupported or invalid."""


class AgentToolError(AgentError):
    """Tool lookup, arguments, or execution failed."""


class AgentRefusal(AgentError):
    """A recoverable model-output problem the model should correct and retry."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


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


class Agent:
    """Run serial provider-neutral Function Calling turns."""

    def __init__(
        self,
        llm: LlmPort,
        tools: ToolRegistry,
        max_tool_rounds: int = 4,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        if max_tool_rounds <= 0:
            raise ValueError("max_tool_rounds must be positive")
        self._llm = llm
        self._tools = tools
        self._max_tool_rounds = max_tool_rounds
        self._monotonic = monotonic or time.monotonic

    def run_turn(
        self,
        conversation: AgentConversation,
        user_text: str,
        *,
        turn_context: AgentTurnContext | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Process one user turn, pausing if structured input is required."""
        return self._run_turn(conversation, user_text, turn_context)

    async def _run_turn(
        self,
        conversation: AgentConversation,
        user_text: str,
        turn_context: AgentTurnContext | None,
    ) -> AsyncIterator[AgentEvent]:
        self._prepare_turn(conversation, user_text, turn_context)
        tool_rounds = 0
        usages: list[LlmUsage] = []
        usage_complete = True
        tool_call_llm_ms = 0.0
        tool_execution_ms = 0.0
        final_text_llm_ms = 0.0

        while True:
            # Stream one model round. Text is spoken as it arrives only once a tool has
            # already run this turn (the final-answer round); the first round is buffered
            # so a tool call's preamble text stays out of the spoken reply.
            streamed = tool_rounds > 0
            text_parts: list[str] = []
            tool_calls: dict[int, _ToolCallAccumulator] = {}
            completed: LlmStreamCompleted | None = None
            round_started = self._monotonic()
            async for event in self._llm.stream(
                conversation.messages,
                self._tools.definitions(),
            ):
                if isinstance(event, TextDelta):
                    text_parts.append(event.text)
                    if streamed:
                        yield AgentTextDelta(event.text)
                elif isinstance(event, ToolCallDelta):
                    tool_calls.setdefault(event.index, _ToolCallAccumulator()).add(event)
                elif isinstance(event, LlmStreamCompleted):
                    if completed is not None:
                        raise AgentProtocolError("LLM stream completed more than once")
                    completed = event
                else:
                    raise AgentProtocolError("Unsupported LLM stream event")

            round_ms = round((self._monotonic() - round_started) * 1000, 1)
            if completed is None:
                raise AgentProtocolError("LLM stream ended without a completion event")
            if completed.usage is None:
                usage_complete = False
            else:
                usages.append(completed.usage)

            if not tool_calls:
                final_text_llm_ms += round_ms
                conversation.messages.append(
                    ChatMessage(role="assistant", content="".join(text_parts))
                )
                if not streamed:
                    for text in text_parts:
                        yield AgentTextDelta(text)
                yield AgentCompleted(
                    _sum_usage(usages) if usage_complete else None,
                    AgentTurnTiming(tool_call_llm_ms, tool_execution_ms, final_text_llm_ms),
                )
                return
            tool_call_llm_ms += round_ms
            if len(tool_calls) != 1:
                raise AgentProtocolError("Parallel Agent tool calls are not supported")
            if tool_rounds >= self._max_tool_rounds:
                raise AgentToolRoundLimitError("Agent tool round limit exceeded")

            accumulator = next(iter(tool_calls.values()))
            tool_call = _complete_tool_call(accumulator)
            arguments = _parse_tool_arguments(tool_call.arguments)
            assistant_message = AssistantToolCallMessage(
                content="".join(text_parts),
                tool_calls=(tool_call,),
            )
            tool_rounds += 1

            if tool_call.name == "request_user_input":
                try:
                    pending = _pending_question_from_arguments(tool_call.call_id, arguments)
                except AgentRefusal as refusal:
                    conversation.messages.extend(
                        [
                            assistant_message,
                            ToolResultMessage(
                                tool_call_id=tool_call.call_id,
                                content=_refusal_json(refusal.reason),
                            ),
                        ]
                    )
                    continue
                conversation.messages.append(assistant_message)
                conversation.pending_question = pending
                yield AgentQuestion(
                    pending.question_kind,
                    pending.speech_text,
                    pending.required_response,
                    pending.candidates,
                )
                return
            if tool_call.name == "end_conversation":
                if arguments:
                    raise AgentToolError("end_conversation arguments must be empty")
                conversation.messages.append(assistant_message)
                if not streamed:
                    for text in text_parts:
                        yield AgentTextDelta(text)
                yield AgentSessionEnd()
                yield AgentCompleted(
                    _sum_usage(usages) if usage_complete else None,
                    AgentTurnTiming(tool_call_llm_ms, tool_execution_ms, final_text_llm_ms),
                )
                return

            try:
                tool = self._tools.get(tool_call.name)
            except KeyError as exc:
                raise AgentToolError(f"Unknown Agent tool: {tool_call.name}") from exc
            exec_started = self._monotonic()
            try:
                result = await tool.execute(arguments)
            except Exception as exc:
                raise AgentToolError(f"Agent tool execution failed: {tool_call.name}") from exc
            tool_execution_ms += round((self._monotonic() - exec_started) * 1000, 1)
            if not isinstance(result, str):
                raise AgentToolError(f"Agent tool returned a non-string result: {tool_call.name}")

            conversation.messages.extend(
                [
                    assistant_message,
                    ToolResultMessage(tool_call_id=tool_call.call_id, content=result),
                ]
            )

    @staticmethod
    def _prepare_turn(
        conversation: AgentConversation,
        user_text: str,
        turn_context: AgentTurnContext | None,
    ) -> None:
        if not conversation.messages:
            system_prompt = SYSTEM_PROMPT
            if turn_context is not None:
                system_prompt = f"{SYSTEM_PROMPT}\n\n{turn_context.system_message()}"
            conversation.messages.append(ChatMessage(role="system", content=system_prompt))
        elif not isinstance(conversation.messages[0], ChatMessage) or (
            conversation.messages[0].role != "system"
        ):
            raise AgentProtocolError("Agent conversation must begin with a system message")
        elif turn_context is not None:
            conversation.messages[0] = ChatMessage(
                role="system",
                content=f"{SYSTEM_PROMPT}\n\n{turn_context.system_message()}",
            )

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
        raise AgentRefusal(
            f"question_kind 必须是 {'、'.join(sorted(_ALLOWED_QUESTION_KINDS))} 之一。"
        )
    if not isinstance(speech_text, str) or not speech_text.strip():
        raise AgentRefusal("speech_text 不能为空，要写出问用户的原话。")
    if required_response is not None and (
        not isinstance(required_response, str) or not required_response.strip()
    ):
        raise AgentRefusal("required_response 不能为空字符串；不需要时省略该字段。")
    if candidates is not None and (
        not isinstance(candidates, list) or not all(isinstance(item, dict) for item in candidates)
    ):
        raise AgentRefusal("candidates 必须是对象数组，每个对象是一个候选日程。")
    if question_kind == "ambiguous_target" and not candidates:
        raise AgentRefusal("ambiguous_target 必须提供非空 candidates。先用 schedule_query 查询。")
    candidate_items = candidates if isinstance(candidates, list) else []
    return PendingQuestion(
        tool_call_id=tool_call_id,
        question_kind=cast(QuestionKind, question_kind),
        speech_text=speech_text.strip(),
        required_response=required_response.strip() if isinstance(required_response, str) else None,
        candidates=tuple(cast(dict[str, Any], item) for item in candidate_items),
    )


def _refusal_json(reason: str) -> str:
    """Render a recoverable problem as a tool result so the model retries."""
    return json.dumps(
        {"status": "failed", "error": {"message": reason}},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _sum_usage(usages: list[LlmUsage]) -> LlmUsage:
    return LlmUsage(
        prompt_tokens=sum(usage.prompt_tokens for usage in usages),
        completion_tokens=sum(usage.completion_tokens for usage in usages),
        total_tokens=sum(usage.total_tokens for usage in usages),
    )
