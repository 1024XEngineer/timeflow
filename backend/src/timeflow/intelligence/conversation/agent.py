"""Serial Agent orchestration and conversation state."""

from __future__ import annotations

import json
import logging
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
from timeflow.intelligence.telemetry import NOOP_TELEMETRY, VoiceTelemetry, tool_result_status

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是 TimeFlow 时间管理助手，只负责用简短自然的语音对话帮用户创建、查询、修改、删除日程，超出范围一律不做。用户说的闹钟、提醒、会议、待办等，都是日程，一律按日程处理，不要按名称划分。

输出：始终中文纯文本、口语化、一句话说完；不客套、不复述、不用 Markdown、不一次罗列多项。

先判断输入属于哪类：
1. 日程操作：按下面「日程操作」执行。
2. 回答上一轮问题：当作补充信息，一次性提取所有日程信息（时间、标题、地点、日期、重复、提醒等），不要只取上一轮问的那一项；提取后再看还缺什么。
3. 无关话题：简短说明「我是时间管理助手，只能帮你管理日程」，拉回日程，不编答案。
4. 噪音：仅当完全无可用信息（「嗯」「啊」、听不清的碎句）才回「抱歉，我没听清，能再说一遍吗？」，不调工具。只要有一点日程相关意图（哪怕含糊、口误、缺字），就别归入噪音，尽力提取可用部分、只追问真正缺的。

铁律：创建/查询/修改/删除必须通过工具执行，只有工具返回 status=ok 才能说「已创建/已删除/已修改/查到了」，返回 error/not_implemented 要如实说没做成。严禁编造任何日程信息（ID、revision、标题、时间、地点、地址、经纬度、候选、查询结果），只能来自工具实际返回。

信息补全：缺信息、要确认、要反问、要让用户选，都调 request_user_input，不要只用文字说；每轮只问一个最关键缺失项，优先问时间或地点。schedule_type（时间/地点）和 schedule_kind（单次/重复）是内部字段，绝不问或提及：提到地点就是地点型、没提就是时间型、没说重复就是单次。speech_text 只放当前这一个问题。

日程操作：
- 创建：title 写成简洁名词短语（去掉「我/帮我/提醒我/记一下」等开头，不含时间地点），如「明天下午三点开会」→「开会」。用户提到地点（包括「附近地铁站」这类泛泛说法）就调 location_search 找候选，别直接问「是哪个」；搜到多条让用户选、一条直接用、没搜到如实说没找到。没提标题用「新建日程」、开始时间用下一个整点、非全天结束时间往后一小时、全天就当整个自然日；提醒默认 medium（非全天 before_start 提前 15 分钟、全天 at_time 当天 10 点）。
- 查询：用户想了解日程时直接 schedule_query，结果如实汇报——先说几条、再逐条说时间/标题/地点；查不到就说没有。按用户实际说的维度筛选：问了具体时间（今天/明天/本周）才加时间范围；说出具体名称（如「周会」）才按标题查。「有哪些日程/日常/安排」这类列举问法就是查全部日程，这些泛指词不是标题，别拿来当 title 过滤。别用「我帮你查一下」这类空话。修改或删除前也先 schedule_query 确认目标；指代不明或命中多条时，把候选放进 request_user_input 的 candidates，别自己选。
- 修改：只支持改整条或整个周期系列，不支持只改某一次；别把「改某一次」误执行为改整个系列。没提到的字段保持原值。「改成/改到 X 点」默认改开始时间 start_time（结束时间顺延一小时），用户说「结束时间/几点结束」才改 end_time。
- 删除：删除前先 request_user_input（confirmation）说清要删的，确认后才 schedule_delete。周期删除按意图定 scope：只删这一次 this_occurrence、这次及以后 this_and_future、整个系列 entire_series。「某一次不参加/跳过/取消这一次」（如「下周一我不参加，其他照旧」）就是删除这一次（this_occurrence），不要改 recurrence_rule。

结束对话：用户明确想结束时（「结束对话」「先这样」「不用了」「再见」等），先道别再调 end_conversation 工具，别只口头说再见。

其他：地点搜索范围由系统处理，别猜城市。相对时间（今天/明天/后天/下周三等）按系统时间和时区换算；「三点」没说上下午的，白天默认下午三点。"""

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


_WEEKDAYS = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")


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
            f"今天是{_WEEKDAYS[local.weekday()]}。"
            f"当前 IANA 时区：{self.timezone}。"
        )


@dataclass(slots=True)
class AgentConversation:
    """In-memory conversation state explicitly owned by the caller."""

    messages: list[LlmMessage] = field(default_factory=list)
    pending_question: PendingQuestion | None = None
    # Kind of the question the user is answering this turn, if any. Used to gate
    # destructive tools: a delete is only authorized right after the user answered
    # a confirmation or recurrence-scope question, never from a fresh command.
    answered_question_kind: QuestionKind | None = None
    # Whether the answered confirmation was an explicit affirmative. Recurrence
    # scope answers are self-authorizing, so this only gates ``confirmation``.
    confirmation_affirmed: bool = False


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
        *,
        telemetry: VoiceTelemetry | None = None,
    ) -> None:
        if max_tool_rounds <= 0:
            raise ValueError("max_tool_rounds must be positive")
        self._llm = llm
        self._tools = tools
        self._max_tool_rounds = max_tool_rounds
        self._monotonic = monotonic or time.monotonic
        self._telemetry = telemetry if telemetry is not None else NOOP_TELEMETRY

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
        correction_attempted = False

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
                final_text = "".join(text_parts)
                logger.info(
                    "agent round=%d produced no tool call, text=%r",
                    tool_rounds,
                    final_text,
                )
                conversation.messages.append(ChatMessage(role="assistant", content=final_text))
                if tool_rounds == 0 and not correction_attempted and _claims_success(final_text):
                    correction_attempted = True
                    logger.warning("agent claimed success without a tool call: %r", final_text)
                    conversation.messages.append(
                        ChatMessage(
                            role="user",
                            content=(
                                "（系统）你刚才没有调用任何工具就声称操作成功，这是不允许的。"
                                "请调用对应的工具真正执行，再根据工具返回结果如实回复。"
                            ),
                        )
                    )
                    continue
                if not streamed:
                    for text in text_parts:
                        yield AgentTextDelta(text)
                if tool_rounds == 0 and _is_farewell(final_text):
                    logger.warning("agent said farewell without end_conversation: %r", final_text)
                    yield AgentSessionEnd()
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
            logger.info(
                "agent tool call name=%s raw_args=%s",
                tool_call.name,
                tool_call.arguments,
            )
            arguments = _parse_tool_arguments(tool_call.arguments)
            assistant_message = AssistantToolCallMessage(
                content="".join(text_parts),
                tool_calls=(tool_call,),
            )
            tool_rounds += 1

            if tool_call.name == "request_user_input":
                tool_span = self._telemetry.start_tool("request_user_input", agent_mode="composed")
                try:
                    pending = _pending_question_from_arguments(tool_call.call_id, arguments)
                except AgentRefusal as refusal:
                    tool_span.finish(status="failed")
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
                tool_span.finish(status="ok")
                yield AgentQuestion(
                    pending.question_kind,
                    pending.speech_text,
                    pending.required_response,
                    pending.candidates,
                )
                return
            if tool_call.name == "end_conversation":
                tool_span = self._telemetry.start_tool("end_conversation", agent_mode="composed")
                if arguments:
                    tool_span.finish(status="error", error_kind="exception")
                    raise AgentToolError("end_conversation arguments must be empty")
                conversation.messages.append(assistant_message)
                tool_span.finish(status="ok")
                if not streamed:
                    for text in text_parts:
                        yield AgentTextDelta(text)
                yield AgentSessionEnd()
                yield AgentCompleted(
                    _sum_usage(usages) if usage_complete else None,
                    AgentTurnTiming(tool_call_llm_ms, tool_execution_ms, final_text_llm_ms),
                )
                return

            if tool_call.name == "schedule_delete" and not _delete_authorized(conversation):
                conversation.messages.extend(
                    [
                        assistant_message,
                        ToolResultMessage(
                            tool_call_id=tool_call.call_id,
                            content=_refusal_json(
                                "删除是不可逆操作，必须先调用 request_user_input（confirmation）"
                                "向用户确认删除目标，得到用户确认后才能 schedule_delete。"
                            ),
                        ),
                    ]
                )
                continue

            tool_span = self._telemetry.start_tool(tool_call.name, agent_mode="composed")
            try:
                tool = self._tools.get(tool_call.name)
            except KeyError as exc:
                tool_span.finish(status="error", error_kind="exception")
                raise AgentToolError(f"Unknown Agent tool: {tool_call.name}") from exc
            exec_started = self._monotonic()
            try:
                result = await tool.execute(arguments)
            except Exception as exc:
                tool_span.finish(status="error", error_kind="exception")
                raise AgentToolError(f"Agent tool execution failed: {tool_call.name}") from exc
            tool_execution_ms += round((self._monotonic() - exec_started) * 1000, 1)
            if not isinstance(result, str):
                tool_span.finish(status="error", error_kind="exception")
                raise AgentToolError(f"Agent tool returned a non-string result: {tool_call.name}")
            tool_span.finish(status=tool_result_status(result))

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
            conversation.answered_question_kind = None
            conversation.confirmation_affirmed = False
            conversation.messages.append(ChatMessage(role="user", content=user_text))
            return

        answer = json.dumps(
            {"user_response": user_text},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        conversation.answered_question_kind = pending.question_kind
        conversation.confirmation_affirmed = (
            pending.question_kind == "confirmation" and _is_affirmative(user_text)
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


_SUCCESS_CLAIM_MARKERS = (
    "已创建",
    "创建成功",
    "已添加",
    "已新建",
    "已记下",
    "已删除",
    "删除成功",
    "已移除",
    "已删掉",
    "已修改",
    "修改成功",
    "已更新",
    "已更改",
    "已改好",
    "已取消",
    "取消成功",
)


def _claims_success(text: str) -> bool:
    """Return True when a no-tool reply still claims a CRUD operation succeeded."""
    return any(marker in text for marker in _SUCCESS_CLAIM_MARKERS)


_FAREWELL_MARKERS = (
    "再见",
    "拜拜",
    "先这样",
    "就这样",
)


def _is_farewell(text: str) -> bool:
    """Return True when a no-tool reply is a farewell that should end the session."""
    return any(marker in text for marker in _FAREWELL_MARKERS)


def _refusal_json(reason: str) -> str:
    """Render a recoverable problem as a tool result so the model retries."""
    return json.dumps(
        {"status": "failed", "error": {"message": reason}},
        ensure_ascii=False,
        separators=(",", ":"),
    )


_CONFIRMATION_NEGATION_MARKERS = ("不", "别", "取消", "算了", "误会")
_CONFIRMATION_AFFIRMATIVE_MARKERS = (
    "确认",
    "是的",
    "对",
    "好的",
    "可以",
    "行",
    "删",
    "没错",
    "没问题",
    "嗯",
)


def _is_affirmative(text: str) -> bool:
    """Whether a confirmation answer explicitly agrees to the deletion.

    A negation word or a bare re-statement (「下周一周会我不参加」) is not an
    explicit agreement, so it is rejected even if it re-states the intent.
    """
    if any(marker in text for marker in _CONFIRMATION_NEGATION_MARKERS):
        return False
    return any(marker in text for marker in _CONFIRMATION_AFFIRMATIVE_MARKERS)


def _delete_authorized(conversation: AgentConversation) -> bool:
    """Whether the current turn is authorized to delete.

    A delete is irreversible, so it is only allowed right after the user answered
    a recurrence-scope question, or a confirmation with an explicit affirmative
    answer. Disambiguation (``ambiguous_target``) only narrows the target and does
    not authorize deletion on its own.
    """
    kind = conversation.answered_question_kind
    if kind == "recurrence_scope":
        return True
    if kind == "confirmation":
        return conversation.confirmation_affirmed
    return False


def _sum_usage(usages: list[LlmUsage]) -> LlmUsage:
    return LlmUsage(
        prompt_tokens=sum(usage.prompt_tokens for usage in usages),
        completion_tokens=sum(usage.completion_tokens for usage in usages),
        total_tokens=sum(usage.total_tokens for usage in usages),
    )
