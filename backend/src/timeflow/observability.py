"""Composition-root adapter: intelligence telemetry backed by Prometheus and Tempo."""

from __future__ import annotations

import time
from collections.abc import Callable
from contextvars import ContextVar

from opentelemetry import context as otel_context
from opentelemetry.trace import (
    Link,
    SpanKind,
    Status,
    StatusCode,
    get_current_span,
    set_span_in_context,
)

from timeflow.infrastructure.observability.metrics import (
    AGENT_PHASE_DURATION,
    TOOL_CALLS,
    TOOL_DURATION,
    VOICE_STAGE_DURATION,
    VOICE_TURNS,
    bound_agent_mode,
    bound_agent_phase,
    bound_stage,
    bound_status,
    bound_turn_status,
    bound_voice_mode,
)
from timeflow.infrastructure.observability.sessions import (
    VOICE_SESSION_OCCUPANCY,
    VoiceSessionOccupancy,
)
from timeflow.infrastructure.observability.tracing import get_tracer
from timeflow.intelligence.telemetry import (
    PROMETHEUS_TOOL_NAMES,
    ToolSpan,
    TurnSpan,
    tool_metric_name,
)

_tool_sequence: ContextVar[int] = ContextVar("timeflow_tool_sequence", default=0)
_current_turn: ContextVar[_TurnSpan | None] = ContextVar("timeflow_current_turn", default=None)

_ACCOUNT_ID_MAX = 64
_USERNAME_MAX = 64
ACCOUNT_ID_ATTRIBUTE = "timeflow.account_id"
USERNAME_ATTRIBUTE = "timeflow.username"


def span_account_id(value: str) -> str:
    """Trim and cap the authenticated account id for Tempo. Never a metric label."""
    text = value.strip()[:_ACCOUNT_ID_MAX]
    return text if text else "unknown"


def span_username(value: str) -> str:
    """Trim and cap the APK login username for Tempo. Never a metric label."""
    text = value.strip()[:_USERNAME_MAX]
    return text if text else "unknown"


class _ToolSpan:
    def __init__(
        self,
        name: str,
        agent_mode: str,
        sequence: int,
        *,
        account_id: str,
        username: str,
    ) -> None:
        self._tool = tool_metric_name(name)
        self._agent_mode = bound_agent_mode(agent_mode)
        self._sequence = sequence
        self._prometheus = self._tool in PROMETHEUS_TOOL_NAMES or self._tool == "other"
        self._started = time.perf_counter()
        self._span = get_tracer("timeflow.voice").start_span(
            f"tool.{self._tool}",
            kind=SpanKind.INTERNAL,
            attributes={
                "timeflow.tool.name": self._tool,
                "timeflow.tool.sequence": sequence,
                "timeflow.agent_mode": self._agent_mode,
                ACCOUNT_ID_ATTRIBUTE: account_id,
                USERNAME_ATTRIBUTE: username,
            },
        )
        self._token = otel_context.attach(set_span_in_context(self._span))

    def finish(self, *, status: str, error_kind: str = "none") -> None:
        duration = time.perf_counter() - self._started
        status_label = bound_status(status)
        if self._prometheus:
            TOOL_CALLS.labels(self._tool, self._agent_mode, status_label).inc()
            TOOL_DURATION.labels(self._tool, self._agent_mode).observe(duration)
        self._span.set_attribute("timeflow.tool.status", status_label)
        self._span.set_attribute("timeflow.tool.error_kind", error_kind)
        self._span.set_attribute("timeflow.duration_ms", round(duration * 1000, 1))
        if status_label != "ok":
            self._span.set_status(Status(StatusCode.ERROR))
        turn = _current_turn.get()
        if turn is not None:
            turn.record_tool(self._tool, sequence=self._sequence, status=status_label)
        self._span.end()
        otel_context.detach(self._token)


class _TurnSpan:
    def __init__(self, agent_mode: str, voice_mode: str, account_id: str, username: str) -> None:
        self._agent_mode = bound_agent_mode(agent_mode)
        self._voice_mode = bound_voice_mode(voice_mode)
        self.account_id = account_id
        self.username = username
        self._tools: list[str] = []
        # A WebSocket session span stays open for the whole connection. Parenting the
        # turn under it hides completed turns from Tempo until disconnect. Start a new
        # trace and keep a link back to the session instead.
        current = get_current_span().get_span_context()
        links = (Link(current),) if current.is_valid else ()
        self._span = get_tracer("timeflow.voice").start_span(
            "voice.turn",
            kind=SpanKind.INTERNAL,
            context=otel_context.Context(),
            links=links,
            attributes={
                "timeflow.agent_mode": self._agent_mode,
                "timeflow.voice_mode": self._voice_mode,
                ACCOUNT_ID_ATTRIBUTE: account_id,
                USERNAME_ATTRIBUTE: username,
            },
        )
        self._token = otel_context.attach(set_span_in_context(self._span))
        self._turn_token = _current_turn.set(self)
        _tool_sequence.set(0)

    def record_tool(self, name: str, *, sequence: int, status: str) -> None:
        self._tools.append(name)
        self._span.set_attribute("timeflow.tools", ",".join(self._tools))
        self._span.set_attribute("timeflow.tool.count", len(self._tools))
        self._span.add_event(
            f"tool.{name}",
            attributes={
                "timeflow.tool.name": name,
                "timeflow.tool.sequence": sequence,
                "timeflow.tool.status": status,
            },
        )

    def record_stage(self, stage: str, duration_ms: float | None) -> None:
        if duration_ms is None:
            return
        stage_label = bound_stage(stage)
        self._span.set_attribute(f"timeflow.{stage_label}_ms", duration_ms)
        self._span.add_event(stage_label, attributes={"duration_ms": duration_ms})
        VOICE_STAGE_DURATION.labels(self._agent_mode, self._voice_mode, stage_label).observe(
            duration_ms / 1000.0
        )

    def record_llm_usage(self, *, prompt_tokens: int, completion_tokens: int) -> None:
        self._span.set_attribute("timeflow.prompt_tokens", prompt_tokens)
        self._span.set_attribute("timeflow.completion_tokens", completion_tokens)

    def finish(self, *, status: str) -> None:
        status_label = bound_turn_status(status)
        self._span.set_attribute("timeflow.status", status_label)
        self._span.set_attribute("timeflow.tools", ",".join(self._tools))
        self._span.set_attribute("timeflow.tool.count", len(self._tools))
        VOICE_TURNS.labels(self._agent_mode, self._voice_mode, status_label).inc()
        if status_label in {"failed", "cancelled"}:
            self._span.set_status(Status(StatusCode.ERROR))
        self._span.end()
        otel_context.detach(self._token)
        _current_turn.reset(self._turn_token)


class PrometheusOtelVoiceTelemetry:
    """Record voice-turn Prometheus samples and Tempo spans from intelligence ports."""

    def __init__(
        self,
        occupancy: VoiceSessionOccupancy | None = None,
        username_for: Callable[[str], str | None] | None = None,
    ) -> None:
        self._occupancy = occupancy if occupancy is not None else VOICE_SESSION_OCCUPANCY
        self._username_for = username_for
        self._usernames: dict[str, str] = {}

    def bind_username_lookup(self, lookup: Callable[[str], str | None]) -> None:
        """Resolve APK login names from account ids. Called once from the composition root."""
        self._username_for = lookup
        self._usernames.clear()

    def start_turn(self, *, agent_mode: str, voice_mode: str, account_id: str) -> TurnSpan:
        return _TurnSpan(
            agent_mode,
            voice_mode,
            span_account_id(account_id),
            self._resolve_username(account_id),
        )

    def start_tool(self, name: str, *, agent_mode: str) -> ToolSpan:
        sequence = _tool_sequence.get() + 1
        _tool_sequence.set(sequence)
        turn = _current_turn.get()
        account_id = turn.account_id if turn is not None else "unknown"
        username = turn.username if turn is not None else "unknown"
        return _ToolSpan(name, agent_mode, sequence, account_id=account_id, username=username)

    def _resolve_username(self, account_id: str) -> str:
        key = account_id.strip()
        if not key:
            return "unknown"
        cached = self._usernames.get(key)
        if cached is not None:
            return cached
        raw = self._username_for(key) if self._username_for is not None else None
        value = span_username(raw or "")
        self._usernames[key] = value
        return value

    def record_agent_timing(
        self,
        *,
        agent_mode: str,
        llm_tool_call_ms: float,
        tool_execution_ms: float,
        llm_final_text_ms: float,
    ) -> None:
        mode = bound_agent_mode(agent_mode)
        AGENT_PHASE_DURATION.labels(mode, bound_agent_phase("llm_tool_call")).observe(
            llm_tool_call_ms / 1000.0
        )
        AGENT_PHASE_DURATION.labels(mode, bound_agent_phase("tool_execution")).observe(
            tool_execution_ms / 1000.0
        )
        AGENT_PHASE_DURATION.labels(mode, bound_agent_phase("llm_final_text")).observe(
            llm_final_text_ms / 1000.0
        )

    def set_session_stage(self, session_id: str, stage: str) -> None:
        self._occupancy.set_stage(session_id, stage)

    def record_interrupt(self, session_id: str) -> None:
        self._occupancy.record_interrupt(session_id)


VOICE_TELEMETRY = PrometheusOtelVoiceTelemetry()


__all__ = [
    "ACCOUNT_ID_ATTRIBUTE",
    "PrometheusOtelVoiceTelemetry",
    "USERNAME_ATTRIBUTE",
    "VOICE_TELEMETRY",
    "span_account_id",
    "span_username",
]
