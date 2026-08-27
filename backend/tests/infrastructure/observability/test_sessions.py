"""Live session occupancy, hangup exclusion, and barge-in counters."""

import time

from observability_support import metric_value

from timeflow.infrastructure.observability.metrics import bound_end_reason, bound_session_stage
from timeflow.infrastructure.observability.sessions import VoiceSessionOccupancy


def _stage(stage: str, *, voice_mode: str = "continuous", agent_mode: str = "composed") -> float:
    return metric_value(
        "timeflow_voice_sessions",
        {"stage": stage, "voice_mode": voice_mode, "agent_mode": agent_mode},
    )


def _ends(reason: str, *, voice_mode: str = "continuous", agent_mode: str = "composed") -> float:
    return metric_value(
        "timeflow_voice_session_ends_total",
        {"reason": reason, "voice_mode": voice_mode, "agent_mode": agent_mode},
    )


def _interrupts(*, voice_mode: str = "continuous", agent_mode: str = "composed") -> float:
    return metric_value(
        "timeflow_voice_interrupts_total",
        {"voice_mode": voice_mode, "agent_mode": agent_mode},
    )


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _enters(stage: str, *, voice_mode: str = "continuous", agent_mode: str = "composed") -> float:
    return metric_value(
        "timeflow_voice_stage_enters_total",
        {"stage": stage, "voice_mode": voice_mode, "agent_mode": agent_mode},
    )


def test_session_stages_are_a_closed_enumeration() -> None:
    assert bound_session_stage("waiting_user") == "waiting_user"
    assert bound_session_stage("asr") == "asr"
    assert bound_session_stage("session-id-must-never-be-a-stage") == "other"
    assert bound_end_reason("ui_hangup") == "ui_hangup"
    assert bound_end_reason("account-id") == "other"


def test_attach_moves_occupancy_between_stages_then_finish_clears_it() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    asr_before = _stage("asr")
    occupancy.attach("occ-attach", voice_mode="continuous", agent_mode="composed")
    try:
        assert _stage("waiting_user") == waiting_before + 1
        occupancy.set_stage("occ-attach", "asr")
        assert _stage("waiting_user") == waiting_before
        assert _stage("asr") == asr_before + 1
    finally:
        occupancy.finish("occ-attach")
    assert _stage("waiting_user") == waiting_before
    assert _stage("asr") == asr_before


def test_unknown_modes_collapse_to_other_and_session_ids_are_not_labels() -> None:
    occupancy = VoiceSessionOccupancy()
    other_before = _stage("waiting_user", voice_mode="other", agent_mode="other")
    occupancy.attach("occ-secret-session", voice_mode="telepathy", agent_mode="secret-agent")
    try:
        assert _stage("waiting_user", voice_mode="other", agent_mode="other") == other_before + 1
    finally:
        occupancy.finish("occ-secret-session")


def test_recent_disconnect_without_session_end_is_ui_hangup() -> None:
    occupancy = VoiceSessionOccupancy()
    before = _ends("ui_hangup")
    occupancy.attach("occ-ui", voice_mode="continuous", agent_mode="composed")
    occupancy.finish("occ-ui")
    assert _ends("ui_hangup") == before + 1


def test_idle_timeout_uses_last_activity_not_connection_age() -> None:
    clock = _Clock()
    occupancy = VoiceSessionOccupancy(clock=clock)
    ui_before = _ends("ui_hangup", voice_mode="push_to_talk", agent_mode="realtime")
    idle_before = _ends("idle_timeout", voice_mode="push_to_talk", agent_mode="realtime")

    occupancy.attach("occ-idle-recent", voice_mode="push_to_talk", agent_mode="realtime")
    clock.now = 100.0
    occupancy.mark_activity("occ-idle-recent")
    clock.now = 279.9
    occupancy.finish("occ-idle-recent")
    assert _ends("ui_hangup", voice_mode="push_to_talk", agent_mode="realtime") == ui_before + 1
    assert _ends("idle_timeout", voice_mode="push_to_talk", agent_mode="realtime") == idle_before

    occupancy.attach("occ-idle-expired", voice_mode="push_to_talk", agent_mode="realtime")
    clock.now = 279.9
    occupancy.mark_activity("occ-idle-expired")
    clock.now = 459.9
    occupancy.finish("occ-idle-expired")
    assert (
        _ends("idle_timeout", voice_mode="push_to_talk", agent_mode="realtime") == idle_before + 1
    )


def test_tool_end_counts_once_and_the_following_close_does_not() -> None:
    occupancy = VoiceSessionOccupancy()
    tool_before = _ends("tool_end")
    ui_before = _ends("ui_hangup")
    occupancy.attach("occ-tool", voice_mode="continuous", agent_mode="composed")
    occupancy.mark_tool_end("occ-tool")
    occupancy.mark_tool_end("occ-tool")
    occupancy.finish("occ-tool")
    assert _ends("tool_end") == tool_before + 1
    assert _ends("ui_hangup") == ui_before


def test_server_error_outranks_exclusion_when_session_end_was_not_sent() -> None:
    occupancy = VoiceSessionOccupancy()
    before = _ends("server_error")
    occupancy.attach("occ-err", voice_mode="continuous", agent_mode="composed")
    occupancy.finish("occ-err", server_error=True)
    assert _ends("server_error") == before + 1


def test_unknown_session_mutations_are_noops() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting = _stage("waiting_user")
    occupancy.set_stage("missing", "llm")
    occupancy.mark_activity("missing")
    occupancy.mark_tool_end("missing")
    occupancy.record_interrupt("missing")
    occupancy.finish("missing")
    assert _stage("waiting_user") == waiting


def test_interrupt_increments_without_session_id_labels() -> None:
    occupancy = VoiceSessionOccupancy()
    before = _interrupts()
    occupancy.attach("occ-int", voice_mode="continuous", agent_mode="composed")
    occupancy.record_interrupt("occ-int")
    occupancy.finish("occ-int")
    assert _interrupts() == before + 1


def test_set_stage_if_current_does_not_overwrite_a_newer_stage() -> None:
    occupancy = VoiceSessionOccupancy()
    asr_before = _stage("asr")
    occupancy.attach("occ-cas", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy.set_stage("occ-cas", "asr")
        occupancy.set_stage_if_current("occ-cas", "waiting_user", current=("tts", "speaking"))
        assert _stage("asr") == asr_before + 1
    finally:
        occupancy.finish("occ-cas")
    assert _stage("asr") == asr_before


def test_hold_speaking_without_remaining_playback_returns_to_waiting_user() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    occupancy.attach("occ-hold", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy.set_stage("occ-hold", "tts")
        occupancy.hold_speaking("occ-hold", 0.0)
        assert _stage("waiting_user") == waiting_before + 1
    finally:
        occupancy.finish("occ-hold")


def test_hold_speaking_expires_to_waiting_user_after_playback() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    occupancy.attach("occ-hold-timer", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy.set_stage("occ-hold-timer", "speaking")
        occupancy.hold_speaking("occ-hold-timer", 0.08)
        time.sleep(0.25)
        assert _stage("waiting_user") == waiting_before + 1
    finally:
        occupancy.finish("occ-hold-timer")


def test_set_stage_if_current_moves_when_the_session_is_still_in_current() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    occupancy.attach("occ-if-current", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy.set_stage("occ-if-current", "speaking")
        occupancy.set_stage_if_current(
            "occ-if-current", "waiting_user", current=("tts", "speaking")
        )
        assert _stage("waiting_user") == waiting_before + 1
    finally:
        occupancy.finish("occ-if-current")


def test_hold_speaking_ignores_unknown_or_non_playback_sessions() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    occupancy.hold_speaking("missing", 1.0)
    occupancy.attach("occ-hold-skip", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy.hold_speaking("occ-hold-skip", 1.0)
        assert _stage("waiting_user") == waiting_before + 1
    finally:
        occupancy.finish("occ-hold-skip")


def test_attach_is_idempotent_for_the_same_session() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    occupancy.attach("occ-dup", voice_mode="continuous", agent_mode="composed")
    occupancy.attach("occ-dup", voice_mode="continuous", agent_mode="composed")
    try:
        assert _stage("waiting_user") == waiting_before + 1
    finally:
        occupancy.finish("occ-dup")


def test_playback_timer_is_ignored_after_the_session_finishes() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_before = _stage("waiting_user")
    occupancy.attach("occ-hold-gone", voice_mode="continuous", agent_mode="composed")
    occupancy.set_stage("occ-hold-gone", "speaking")
    occupancy.hold_speaking("occ-hold-gone", 0.2)
    occupancy.finish("occ-hold-gone")
    time.sleep(0.35)
    assert _stage("waiting_user") == waiting_before


def test_playback_elapsed_ignores_stale_or_missing_sessions() -> None:
    occupancy = VoiceSessionOccupancy()
    occupancy._playback_elapsed("missing", 0)
    occupancy.attach("occ-stale", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy._playback_elapsed("occ-stale", -1)
    finally:
        occupancy.finish("occ-stale")


def test_stage_enters_count_each_transition() -> None:
    occupancy = VoiceSessionOccupancy()
    waiting_enters = _enters("waiting_user")
    asr_enters = _enters("asr")
    occupancy.attach("occ-enters", voice_mode="continuous", agent_mode="composed")
    try:
        occupancy.set_stage("occ-enters", "asr")
        occupancy.set_stage("occ-enters", "asr")
        assert _enters("waiting_user") == waiting_enters + 1
        assert _enters("asr") == asr_enters + 1
    finally:
        occupancy.finish("occ-enters")
