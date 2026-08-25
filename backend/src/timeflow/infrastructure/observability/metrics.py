"""Prometheus instruments for infrastructure adapters, database, and voice turns.

Label values are closed enumerations. Session ids, transcripts, titles, coordinates,
and credential material never appear here.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

HTTP_LATENCY_BUCKETS = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
)
VOICE_LATENCY_BUCKETS = (
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    20.0,
    30.0,
    60.0,
)
DB_LATENCY_BUCKETS = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5)
TOOL_LATENCY_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)

VOICE_TURNS = Counter(
    "timeflow_voice_turns_total",
    "Completed voice turns by agent mode, voice mode, and outcome.",
    ("agent_mode", "voice_mode", "status"),
)
VOICE_SESSIONS = Gauge(
    "timeflow_voice_sessions",
    "Authenticated voice sessions currently occupying a bounded stage.",
    ("stage", "voice_mode", "agent_mode"),
)
VOICE_SESSION_ENDS = Counter(
    "timeflow_voice_session_ends_total",
    "Voice session endings by bounded reason, voice mode, and agent mode.",
    ("reason", "voice_mode", "agent_mode"),
)
VOICE_INTERRUPTS = Counter(
    "timeflow_voice_interrupts_total",
    "Successful barge-ins that cut a spoken reply short.",
    ("voice_mode", "agent_mode"),
)
VOICE_STAGE_ENTERS = Counter(
    "timeflow_voice_stage_enters_total",
    "Times a live session entered a bounded occupancy stage.",
    ("stage", "voice_mode", "agent_mode"),
)
VOICE_STAGE_DURATION = Histogram(
    "timeflow_voice_stage_duration_seconds",
    "Voice-turn stage durations in seconds.",
    ("agent_mode", "voice_mode", "stage"),
    buckets=VOICE_LATENCY_BUCKETS,
)
AGENT_PHASE_DURATION = Histogram(
    "timeflow_agent_phase_duration_seconds",
    "Agent LLM-versus-tool phase durations in seconds.",
    ("agent_mode", "phase"),
    buckets=VOICE_LATENCY_BUCKETS,
)
TOOL_CALLS = Counter(
    "timeflow_tool_calls_total",
    "Agent tool invocations by bounded tool name, agent mode, and outcome.",
    ("tool", "agent_mode", "status"),
)
TOOL_DURATION = Histogram(
    "timeflow_tool_call_duration_seconds",
    "Agent tool execution duration in seconds.",
    ("tool", "agent_mode"),
    buckets=TOOL_LATENCY_BUCKETS,
)

EXTERNAL_REQUESTS = Counter(
    "timeflow_external_requests_total",
    "Outbound provider calls by dependency, operation, outcome, and error kind.",
    ("dependency", "operation", "status", "error_kind"),
)
EXTERNAL_DURATION = Histogram(
    "timeflow_external_request_duration_seconds",
    "Outbound provider call duration in seconds.",
    ("dependency", "operation", "status"),
    buckets=VOICE_LATENCY_BUCKETS,
)
EXTERNAL_FIRST_BYTE = Histogram(
    "timeflow_external_first_byte_duration_seconds",
    "Time to first useful provider byte or event, in seconds.",
    ("dependency", "operation"),
    buckets=VOICE_LATENCY_BUCKETS,
)
EXTERNAL_IN_FLIGHT = Gauge(
    "timeflow_external_in_flight",
    "In-flight outbound provider calls.",
    ("dependency",),
)
LLM_TOKENS = Counter(
    "timeflow_llm_tokens_total",
    "LLM token counts reported by the provider; values only, never token strings.",
    ("operation", "direction"),
)
ASR_CONNECTIONS = Counter(
    "timeflow_asr_connections_total",
    "Aliyun ASR WebSocket connect attempts.",
    ("status",),
)
ASR_CONNECT_DURATION = Histogram(
    "timeflow_asr_connect_duration_seconds",
    "Aliyun ASR WebSocket connect duration in seconds.",
    ("status",),
    buckets=HTTP_LATENCY_BUCKETS,
)
TTS_CONNECTIONS = Counter(
    "timeflow_tts_connections_total",
    "Aliyun TTS WebSocket connect attempts.",
    ("status",),
)
TTS_CONNECT_DURATION = Histogram(
    "timeflow_tts_connect_duration_seconds",
    "Aliyun TTS WebSocket connect duration in seconds.",
    ("status",),
    buckets=HTTP_LATENCY_BUCKETS,
)
REALTIME_CONNECTIONS = Counter(
    "timeflow_realtime_connections_total",
    "Aliyun realtime audio session connect attempts.",
    ("status",),
)
REALTIME_CONNECT_DURATION = Histogram(
    "timeflow_realtime_connect_duration_seconds",
    "Aliyun realtime audio session connect duration in seconds.",
    ("status",),
    buckets=HTTP_LATENCY_BUCKETS,
)
REALTIME_EVENTS = Counter(
    "timeflow_realtime_events_total",
    "Realtime session frames by bounded event class, never payloads.",
    ("kind",),
)

DB_QUERIES = Counter(
    "timeflow_db_queries_total",
    "SQL statements by bounded operation kind and outcome.",
    ("operation", "status"),
)
DB_QUERY_DURATION = Histogram(
    "timeflow_db_query_duration_seconds",
    "SQL statement duration in seconds.",
    ("operation", "status"),
    buckets=DB_LATENCY_BUCKETS,
)
DB_POOL_SIZE = Gauge(
    "timeflow_db_pool_size",
    "SQLAlchemy connection pool size.",
)
DB_POOL_CHECKED_OUT = Gauge(
    "timeflow_db_pool_checked_out",
    "SQLAlchemy connections currently checked out.",
)
DB_POOL_ERRORS = Counter(
    "timeflow_db_pool_errors_total",
    "SQLAlchemy pool invalidate and connect failures.",
    ("kind",),
)

BOUNDED_STATUSES = frozenset(
    {
        "ok",
        "error",
        "cancelled",
        "timeout",
        "failed",
        "invalid_input",
        "provider_unavailable",
        "exception",
        "none",
    }
)
BOUNDED_ERROR_KINDS = frozenset(
    {
        "none",
        "connection",
        "timeout",
        "protocol",
        "provider",
        "transcription",
        "synthesis",
        "cancelled",
        "exception",
    }
)
BOUNDED_DEPENDENCIES = frozenset({"asr", "llm", "tts", "maps", "realtime", "database"})
BOUNDED_AGENT_MODES = frozenset({"composed", "realtime"})
BOUNDED_VOICE_MODES = frozenset({"push_to_talk", "continuous"})
BOUNDED_TURN_STATUSES = frozenset(
    {
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "empty_transcript",
        "stale",
    }
)
BOUNDED_STAGES = frozenset(
    {
        "audio_duration",
        "audio_input_wall",
        "asr_total",
        "asr_finalize",
        "asr_first_final",
        "llm_agent_first_output",
        "llm_agent_total",
        "llm_tool_call",
        "tool_execution",
        "llm_final_text",
        "tts_first_audio",
        "tts_total",
        "turn_total",
    }
)
BOUNDED_AGENT_PHASES = frozenset({"llm_tool_call", "tool_execution", "llm_final_text"})
BOUNDED_SESSION_STAGES = frozenset(
    {"waiting_user", "asr", "llm", "tool", "tts", "speaking", "other"}
)
BOUNDED_END_REASONS = frozenset({"tool_end", "idle_timeout", "ui_hangup", "server_error"})
BOUNDED_DB_OPERATIONS = frozenset(
    {"SELECT", "INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "ROLLBACK", "OTHER"}
)
BOUNDED_OPERATIONS = frozenset(
    {
        "stream",
        "json",
        "connect",
        "session",
        "reverse",
        "search",
        "open",
        "pump",
        "recognize",
        "synthesize",
    }
)
BOUNDED_REALTIME_EVENTS = frozenset(
    {
        "input_transcript",
        "output_transcript",
        "audio",
        "tool",
        "response_done",
        "error",
        "other",
    }
)


def bound_label(value: str, allowed: frozenset[str], *, default: str = "other") -> str:
    """Replace an unexpected label with a constant so cardinality cannot explode."""
    return value if value in allowed else default


def bound_status(value: str) -> str:
    """Map an outcome string onto the closed Prometheus status set."""
    if value == "applied":
        return "ok"
    return bound_label(value, BOUNDED_STATUSES)


def bound_error_kind(value: str) -> str:
    """Map an error classification onto the closed Prometheus error-kind set."""
    return bound_label(value, BOUNDED_ERROR_KINDS, default="exception")


def bound_dependency(value: str) -> str:
    """Map a dependency name onto the closed Prometheus dependency set."""
    return bound_label(value, BOUNDED_DEPENDENCIES)


def bound_agent_mode(value: str) -> str:
    """Map an agent mode onto composed, realtime, or other."""
    return bound_label(value, BOUNDED_AGENT_MODES)


def bound_voice_mode(value: str) -> str:
    """Map a voice mode onto push_to_talk, continuous, or other."""
    return bound_label(value, BOUNDED_VOICE_MODES)


def bound_turn_status(value: str) -> str:
    """Map a turn outcome onto the closed Prometheus turn-status set."""
    return bound_label(value, BOUNDED_TURN_STATUSES)


def bound_stage(value: str) -> str:
    """Map a timing field name onto a closed stage label, stripping a trailing _ms."""
    stage = value[:-3] if value.endswith("_ms") else value
    return bound_label(stage, BOUNDED_STAGES)


def bound_agent_phase(value: str) -> str:
    """Map an Agent timing field onto the closed phase set."""
    phase = value[:-3] if value.endswith("_ms") else value
    return bound_label(phase, BOUNDED_AGENT_PHASES)


def bound_session_stage(value: str) -> str:
    """Map a live-session occupancy name onto the closed stage set."""
    return bound_label(value, BOUNDED_SESSION_STAGES)


def bound_end_reason(value: str) -> str:
    """Map a hangup classification onto the closed end-reason set."""
    return bound_label(value, BOUNDED_END_REASONS)


def bound_operation(value: str) -> str:
    """Map an outbound operation onto the closed Prometheus operation set."""
    return bound_label(value, BOUNDED_OPERATIONS)


def bound_realtime_event(value: str) -> str:
    """Map a realtime frame type onto a closed event class, never the payload."""
    return bound_label(value, BOUNDED_REALTIME_EVENTS)


def bound_db_operation(statement: str) -> str:
    """Classify a SQL string by its leading keyword only; never keep the statement."""
    token = statement.lstrip().split(None, 1)[0].upper() if statement.strip() else "OTHER"
    return token if token in BOUNDED_DB_OPERATIONS else "OTHER"


def prime_voice_session_series() -> None:
    """Export zero samples so Grafana can graph stages and hangups before the first event.

    Prometheus ``increase()`` drops the first increment of a brand-new series. Gauges
    for unused stages are also absent until someone occupies them. Zero-fill the
    closed enumerations once at import.
    """
    for stage in sorted(BOUNDED_SESSION_STAGES):
        for voice_mode in sorted(BOUNDED_VOICE_MODES):
            for agent_mode in sorted(BOUNDED_AGENT_MODES):
                VOICE_SESSIONS.labels(stage, voice_mode, agent_mode).set(0)
                VOICE_STAGE_ENTERS.labels(stage, voice_mode, agent_mode).inc(0)
    for reason in sorted(BOUNDED_END_REASONS):
        for voice_mode in sorted(BOUNDED_VOICE_MODES):
            for agent_mode in sorted(BOUNDED_AGENT_MODES):
                VOICE_SESSION_ENDS.labels(reason, voice_mode, agent_mode).inc(0)
    for voice_mode in sorted(BOUNDED_VOICE_MODES):
        for agent_mode in sorted(BOUNDED_AGENT_MODES):
            VOICE_INTERRUPTS.labels(voice_mode, agent_mode).inc(0)


prime_voice_session_series()


__all__ = [
    "AGENT_PHASE_DURATION",
    "ASR_CONNECTIONS",
    "ASR_CONNECT_DURATION",
    "DB_POOL_CHECKED_OUT",
    "DB_POOL_ERRORS",
    "DB_POOL_SIZE",
    "DB_QUERIES",
    "DB_QUERY_DURATION",
    "EXTERNAL_DURATION",
    "EXTERNAL_FIRST_BYTE",
    "EXTERNAL_IN_FLIGHT",
    "EXTERNAL_REQUESTS",
    "LLM_TOKENS",
    "REALTIME_CONNECTIONS",
    "REALTIME_CONNECT_DURATION",
    "REALTIME_EVENTS",
    "TOOL_CALLS",
    "TOOL_DURATION",
    "TTS_CONNECTIONS",
    "TTS_CONNECT_DURATION",
    "VOICE_INTERRUPTS",
    "VOICE_SESSIONS",
    "VOICE_SESSION_ENDS",
    "VOICE_STAGE_DURATION",
    "VOICE_STAGE_ENTERS",
    "VOICE_TURNS",
    "prime_voice_session_series",
    "bound_agent_mode",
    "bound_agent_phase",
    "bound_db_operation",
    "bound_dependency",
    "bound_end_reason",
    "bound_operation",
    "bound_realtime_event",
    "bound_error_kind",
    "bound_label",
    "bound_session_stage",
    "bound_stage",
    "bound_status",
    "bound_turn_status",
    "bound_voice_mode",
]
