"""Session occupancy seam used by the WebSocket transport.

The Prometheus implementation lives in infrastructure so this layer does not import
it. The composition root injects a tracker that matches this protocol.
"""

from typing import Protocol


class VoiceSessionTracker(Protocol):
    """Observe occupancy, idle timing, hangups, and barge-ins for one WS session."""

    def attach(self, session_id: str, *, voice_mode: str, agent_mode: str) -> None:
        """Count an authenticated session as waiting for the user."""

    def finish(self, session_id: str, *, server_error: bool = False) -> None:
        """Clear occupancy and classify the hangup unless tool_end already counted."""

    def set_stage(self, session_id: str, stage: str) -> None:
        """Move the session into a bounded live stage."""

    def set_stage_if_current(
        self, session_id: str, stage: str, *, current: tuple[str, ...]
    ) -> None:
        """Move occupancy only when the session is still in one of ``current``."""

    def hold_speaking(self, session_id: str, remaining_seconds: float) -> None:
        """Keep occupancy on speaking until estimated client playback would finish."""

    def mark_activity(self, session_id: str) -> None:
        """Refresh last meaningful activity (ASR completed or TTS end)."""

    def mark_tool_end(self, session_id: str) -> None:
        """Record that voice.session.end was delivered for this session."""

    def record_interrupt(self, session_id: str) -> None:
        """Record a successful barge-in that cut spoken audio short."""


class NoOpVoiceSessionTracker:
    """Default tracker used by tests that do not inject occupancy."""

    def attach(self, session_id: str, *, voice_mode: str, agent_mode: str) -> None:
        del session_id, voice_mode, agent_mode

    def finish(self, session_id: str, *, server_error: bool = False) -> None:
        del session_id, server_error

    def set_stage(self, session_id: str, stage: str) -> None:
        del session_id, stage

    def set_stage_if_current(
        self, session_id: str, stage: str, *, current: tuple[str, ...]
    ) -> None:
        del session_id, stage, current

    def hold_speaking(self, session_id: str, remaining_seconds: float) -> None:
        del session_id, remaining_seconds

    def mark_activity(self, session_id: str) -> None:
        del session_id

    def mark_tool_end(self, session_id: str) -> None:
        del session_id

    def record_interrupt(self, session_id: str) -> None:
        del session_id


NOOP_SESSION_TRACKER = NoOpVoiceSessionTracker()


__all__ = ["NOOP_SESSION_TRACKER", "NoOpVoiceSessionTracker", "VoiceSessionTracker"]
