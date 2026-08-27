"""In-process occupancy and hangup classification for authenticated voice sessions.

Session ids stay in this process dict. They are never Prometheus labels. Idle hangup
uses the same 180s window as the client's continuous-mode timer, reset on the same
signals: session attach, ASR completed, and TTS end — never inbound PCM.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock

from timeflow.infrastructure.observability.metrics import (
    VOICE_INTERRUPTS,
    VOICE_SESSION_ENDS,
    VOICE_SESSIONS,
    VOICE_STAGE_ENTERS,
    bound_agent_mode,
    bound_end_reason,
    bound_session_stage,
    bound_voice_mode,
)

SESSION_IDLE_TIMEOUT_SECONDS = 180.0
_PLAYBACK_HOLD_SECONDS = 0.05


@dataclass(slots=True)
class _Sample:
    voice_mode: str
    agent_mode: str
    stage: str
    last_activity: float
    ended: bool = False
    generation: int = 0


class VoiceSessionOccupancy:
    """Track live stage gauges and classify each session's single hangup reason."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] | None = None,
        idle_timeout_seconds: float = SESSION_IDLE_TIMEOUT_SECONDS,
    ) -> None:
        self._clock = clock or time.monotonic
        self._idle_timeout_seconds = idle_timeout_seconds
        self._lock = Lock()
        self._sessions: dict[str, _Sample] = {}
        self._timers: dict[str, threading.Timer] = {}

    def attach(self, session_id: str, *, voice_mode: str, agent_mode: str) -> None:
        """Count a session as waiting for the user after authentication."""
        voice_mode = bound_voice_mode(voice_mode)
        agent_mode = bound_agent_mode(agent_mode)
        with self._lock:
            if session_id in self._sessions:
                return
            sample = _Sample(
                voice_mode=voice_mode,
                agent_mode=agent_mode,
                stage="waiting_user",
                last_activity=self._clock(),
            )
            self._sessions[session_id] = sample
            VOICE_SESSIONS.labels("waiting_user", voice_mode, agent_mode).inc()
            VOICE_STAGE_ENTERS.labels("waiting_user", voice_mode, agent_mode).inc()

    def set_stage(self, session_id: str, stage: str) -> None:
        """Move occupancy from the session's current stage to ``stage``."""
        stage = bound_session_stage(stage)
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None:
                return
            self._move_locked(session_id, sample, stage)

    def set_stage_if_current(
        self, session_id: str, stage: str, *, current: tuple[str, ...]
    ) -> None:
        """Move occupancy only when the session is still in one of ``current``."""
        stage = bound_session_stage(stage)
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None or sample.stage not in current:
                return
            self._move_locked(session_id, sample, stage)

    def hold_speaking(self, session_id: str, remaining_seconds: float) -> None:
        """Keep occupancy on speaking until estimated client playback would finish.

        TTS bytes often leave the server faster than they play. Reverting to
        ``waiting_user`` at send-complete makes Grafana miss speaking, and a late
        ``waiting_user`` write can overwrite a barge-in that already moved to ASR.
        """
        callback: Callable[[], None] | None = None
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None or sample.stage not in {"tts", "speaking"}:
                return
            self._move_locked(session_id, sample, "speaking")
            generation = sample.generation
            self._cancel_timer_locked(session_id)
            if remaining_seconds <= _PLAYBACK_HOLD_SECONDS:
                self._move_locked(session_id, sample, "waiting_user")
                return
            timer = threading.Timer(
                remaining_seconds, self._playback_elapsed, args=(session_id, generation)
            )
            timer.daemon = True
            self._timers[session_id] = timer
            callback = timer.start
        if callback is not None:
            callback()

    def mark_activity(self, session_id: str) -> None:
        """Refresh idle timing after ASR completed or TTS end, matching the client."""
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None:
                return
            sample.last_activity = self._clock()

    def mark_tool_end(self, session_id: str) -> None:
        """Count ``tool_end`` once when ``voice.session.end`` is delivered."""
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None or sample.ended:
                return
            sample.ended = True
            VOICE_SESSION_ENDS.labels("tool_end", sample.voice_mode, sample.agent_mode).inc()

    def record_interrupt(self, session_id: str) -> None:
        """Count a barge-in that cancelled a reply the client may already be hearing."""
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None:
                return
            VOICE_INTERRUPTS.labels(sample.voice_mode, sample.agent_mode).inc()

    def finish(self, session_id: str, *, server_error: bool = False) -> None:
        """Drop occupancy and classify the hangup unless ``tool_end`` already ran."""
        with self._lock:
            sample = self._sessions.pop(session_id, None)
            if sample is None:
                return
            self._cancel_timer_locked(session_id)
            VOICE_SESSIONS.labels(sample.stage, sample.voice_mode, sample.agent_mode).dec()
            if sample.ended:
                return
            if server_error:
                reason = "server_error"
            elif self._clock() - sample.last_activity >= self._idle_timeout_seconds:
                reason = "idle_timeout"
            else:
                reason = "ui_hangup"
            VOICE_SESSION_ENDS.labels(
                bound_end_reason(reason), sample.voice_mode, sample.agent_mode
            ).inc()

    def _move_locked(self, session_id: str, sample: _Sample, stage: str) -> None:
        if sample.stage == stage:
            return
        self._cancel_timer_locked(session_id)
        VOICE_SESSIONS.labels(sample.stage, sample.voice_mode, sample.agent_mode).dec()
        sample.stage = stage
        sample.generation += 1
        VOICE_SESSIONS.labels(stage, sample.voice_mode, sample.agent_mode).inc()
        VOICE_STAGE_ENTERS.labels(stage, sample.voice_mode, sample.agent_mode).inc()

    def _cancel_timer_locked(self, session_id: str) -> None:
        timer = self._timers.pop(session_id, None)
        if timer is not None:
            timer.cancel()

    def _playback_elapsed(self, session_id: str, generation: int) -> None:
        with self._lock:
            sample = self._sessions.get(session_id)
            if sample is None or sample.generation != generation:
                return
            if sample.stage == "speaking":
                self._move_locked(session_id, sample, "waiting_user")


VOICE_SESSION_OCCUPANCY = VoiceSessionOccupancy()


__all__ = [
    "SESSION_IDLE_TIMEOUT_SECONDS",
    "VOICE_SESSION_OCCUPANCY",
    "VoiceSessionOccupancy",
]
