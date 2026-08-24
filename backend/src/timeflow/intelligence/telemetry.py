"""Provider-neutral voice and tool telemetry seams.

Intelligence records turn and tool boundaries through this module. Prometheus and
Tempo implementations live in infrastructure so this layer never imports those SDKs.
"""

from __future__ import annotations

import json
from typing import Protocol

KNOWN_TOOL_NAMES = frozenset(
    {
        "schedule_query",
        "schedule_create",
        "schedule_update",
        "schedule_delete",
        "location_search",
        "request_user_input",
        "end_conversation",
    }
)

PROMETHEUS_TOOL_NAMES = frozenset(
    {
        "schedule_query",
        "schedule_create",
        "schedule_update",
        "schedule_delete",
        "location_search",
    }
)

_TOOL_RESULT_STATUSES = frozenset(
    {"ok", "applied", "error", "failed", "invalid_input", "provider_unavailable"}
)


class ToolSpan(Protocol):
    """One tool invocation, finished exactly once."""

    def finish(self, *, status: str, error_kind: str = "none") -> None:
        """Record the outcome without attaching tool arguments or result text."""


class TurnSpan(Protocol):
    """One user utterance from first audio to the last spoken reply."""

    def record_stage(self, stage: str, duration_ms: float | None) -> None:
        """Attach a named stage duration when the stage actually ran."""

    def record_llm_usage(self, *, prompt_tokens: int, completion_tokens: int) -> None:
        """Attach numeric token counts for this turn; never the token strings."""

    def finish(self, *, status: str) -> None:
        """Close the turn after stage fields have been recorded."""


class VoiceTelemetry(Protocol):
    """Observe composed and realtime voice turns without vendor or transport types."""

    def start_turn(self, *, agent_mode: str, voice_mode: str) -> TurnSpan:
        """Open a turn. Tool spans started afterward nest under it when context is active."""

    def start_tool(self, name: str, *, agent_mode: str) -> ToolSpan:
        """Open the next tool call in the current turn's sequence."""

    def record_agent_timing(
        self,
        *,
        agent_mode: str,
        llm_tool_call_ms: float,
        tool_execution_ms: float,
        llm_final_text_ms: float,
    ) -> None:
        """Record the Agent's LLM-versus-tool phase breakdown."""


class _NoOpToolSpan:
    def finish(self, *, status: str, error_kind: str = "none") -> None:
        del status, error_kind


class _NoOpTurnSpan:
    def record_stage(self, stage: str, duration_ms: float | None) -> None:
        del stage, duration_ms

    def record_llm_usage(self, *, prompt_tokens: int, completion_tokens: int) -> None:
        del prompt_tokens, completion_tokens

    def finish(self, *, status: str) -> None:
        del status


class NoOpVoiceTelemetry:
    """Default telemetry that records nothing, used by tests and uninstrumented agents."""

    def start_turn(self, *, agent_mode: str, voice_mode: str) -> TurnSpan:
        del agent_mode, voice_mode
        return _NoOpTurnSpan()

    def start_tool(self, name: str, *, agent_mode: str) -> ToolSpan:
        del name, agent_mode
        return _NoOpToolSpan()

    def record_agent_timing(
        self,
        *,
        agent_mode: str,
        llm_tool_call_ms: float,
        tool_execution_ms: float,
        llm_final_text_ms: float,
    ) -> None:
        del agent_mode, llm_tool_call_ms, tool_execution_ms, llm_final_text_ms


NOOP_TELEMETRY = NoOpVoiceTelemetry()


def tool_metric_name(name: str) -> str:
    """Bound tool-name cardinality to the known Function set plus ``other``."""
    return name if name in KNOWN_TOOL_NAMES else "other"


def tool_result_status(result: str) -> str:
    """Map a tool JSON envelope to a bounded status without copying payload fields."""
    try:
        payload = json.loads(result)
    except json.JSONDecodeError:
        return "ok"
    if not isinstance(payload, dict):
        return "ok"
    status = payload.get("status")
    if not isinstance(status, str) or status not in _TOOL_RESULT_STATUSES:
        return "ok"
    if status == "applied":
        return "ok"
    return status


__all__ = [
    "KNOWN_TOOL_NAMES",
    "NOOP_TELEMETRY",
    "NoOpVoiceTelemetry",
    "PROMETHEUS_TOOL_NAMES",
    "ToolSpan",
    "TurnSpan",
    "VoiceTelemetry",
    "tool_metric_name",
    "tool_result_status",
]
