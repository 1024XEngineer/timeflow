"""Result sink translating each of the agent's outlets into the protocol message for it."""

import logging
import time
from collections.abc import AsyncIterator

from timeflow.business.calendar.contracts import ScheduleCategory
from timeflow.gateway.observability.sessions import (
    NOOP_SESSION_TRACKER,
    VoiceSessionTracker,
)
from timeflow.gateway.websocket.agent_ports import (
    AudioCanceledInfo,
    AudioReplyInfo,
    CommandOutcome,
    DialogueQuestionInfo,
    ReplyTextProgress,
    StreamIdentity,
    TranscriptResult,
)
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.messages.agent import (
    ScheduleCategoryUpdated,
    ScheduleCategoryUpdatedPayload,
    VoiceAsrCompleted,
    VoiceAsrCompletedPayload,
    VoiceCommandResult,
    VoiceCommandResultPayload,
)
from timeflow.gateway.websocket.messages.dialogue import (
    QUESTION_KINDS,
    QuestionKind,
    VoiceDialogueQuestion,
    VoiceDialogueQuestionPayload,
    VoiceDialogueReply,
    VoiceDialogueReplyPayload,
)
from timeflow.gateway.websocket.messages.tts import (
    VoiceTtsCanceled,
    VoiceTtsEnd,
    VoiceTtsStart,
    VoiceTtsStartPayload,
)
from timeflow.gateway.websocket.messages.voice import VoiceSessionEnd

logger = logging.getLogger(__name__)


def _question_kind(value: str) -> QuestionKind:
    """Narrow a producer's string to the protocol's four kinds, refusing anything else."""
    if value not in QUESTION_KINDS:
        raise ValueError(f"question_kind must be one of {QUESTION_KINDS}, got {value!r}")
    return value


class WebSocketResultSink:
    """Translate results into wire messages and push them to the session."""

    def __init__(
        self,
        connections: ConnectionManager,
        sessions: VoiceSessionTracker | None = None,
    ) -> None:
        """Store the registry used to reach the session."""
        self._connections = connections
        self._sessions = sessions if sessions is not None else NOOP_SESSION_TRACKER

    async def deliver_transcript(
        self, transcript: TranscriptResult, stream: StreamIdentity
    ) -> None:
        """Push what the user was heard to say."""
        message = VoiceAsrCompleted(
            request_id=stream.request_id,
            conversation_id=stream.conversation_id,
            payload=VoiceAsrCompletedPayload(
                transcript=transcript.text,
                language=transcript.language,
                duration_ms=transcript.duration_ms,
            ),
        )
        await self._send(stream.session_id, message.type, message.model_dump())
        self._sessions.mark_activity(stream.session_id)

    async def deliver_reply_text(self, reply: ReplyTextProgress, stream: StreamIdentity) -> None:
        """Push how much of the reply's wording is known so far."""
        message = VoiceDialogueReply(
            request_id=stream.request_id,
            conversation_id=stream.conversation_id,
            payload=VoiceDialogueReplyPayload(
                reply_id=reply.reply_id,
                speech_text=reply.speech_text,
                done=reply.done,
            ),
        )
        await self._send(stream.session_id, message.type, message.model_dump())

    async def deliver_result(self, result: CommandOutcome, stream: StreamIdentity) -> None:
        """Push the outcome of a command the agent carried out."""
        message = VoiceCommandResult(
            message_id=result.message_id,
            request_id=stream.request_id,
            conversation_id=stream.conversation_id,
            payload=VoiceCommandResultPayload(
                operation=result.operation,
                status=result.status,
                schedule=result.schedule,
                schedules=result.schedules,
                occurrence_overrides=result.occurrence_overrides,
            ),
        )
        await self._send(stream.session_id, message.type, message.model_dump(exclude_none=True))

    async def deliver_question(
        self, question: DialogueQuestionInfo, stream: StreamIdentity
    ) -> None:
        """Push a question the user has to answer before the turn can go further."""
        message = VoiceDialogueQuestion(
            request_id=stream.request_id,
            conversation_id=stream.conversation_id,
            payload=VoiceDialogueQuestionPayload(
                question_id=question.question_id,
                question_kind=_question_kind(question.question_kind),
                speech_text=question.speech_text,
                required_response=question.required_response,
                candidates=list(question.candidates),
            ),
        )
        await self._send(stream.session_id, message.type, message.model_dump())

    async def deliver_audio(
        self, reply: AudioReplyInfo, chunks: AsyncIterator[bytes], stream: StreamIdentity
    ) -> None:
        """Speak a reply, putting each chunk on the wire as it is produced."""
        start = VoiceTtsStart(
            conversation_id=stream.conversation_id,
            audio_id=reply.audio_id,
            payload=VoiceTtsStartPayload(
                format=reply.audio_format,
                sample_rate_hz=reply.sample_rate_hz,
                purpose=reply.purpose,
                speech_text=reply.speech_text,
            ),
        )
        end = VoiceTtsEnd(conversation_id=stream.conversation_id, audio_id=reply.audio_id)

        session_id = stream.session_id
        self._sessions.set_stage(session_id, "tts")
        first_chunk = True
        bytes_sent = 0
        sent_at = time.monotonic()

        async def watched() -> AsyncIterator[bytes]:
            nonlocal first_chunk, bytes_sent
            async for chunk in chunks:
                if not chunk:
                    continue
                bytes_sent += len(chunk)
                if first_chunk:
                    first_chunk = False
                    self._sessions.set_stage(session_id, "speaking")
                yield chunk

        delivered = False
        try:
            delivered = await self._connections.stream_audio(
                session_id, start.model_dump(), watched(), end.model_dump()
            )
        finally:
            self._sessions.mark_activity(session_id)
            elapsed = time.monotonic() - sent_at
            remaining = bytes_sent / max(reply.sample_rate_hz * 2, 1) - elapsed
            if remaining > 0.05:
                self._sessions.hold_speaking(session_id, remaining)
            else:
                self._sessions.set_stage_if_current(
                    session_id, "waiting_user", current=("tts", "speaking")
                )
        if not delivered:
            logger.info(
                "stopped speaking to a session that had gone",
                extra={"session_id": session_id, "audio_id": reply.audio_id},
            )

    async def deliver_canceled(self, canceled: AudioCanceledInfo, stream: StreamIdentity) -> None:
        """Push that a reply the client may already be hearing was cut short.

        Sent ahead of the voice.tts.end that always still follows it.
        """
        message = VoiceTtsCanceled(
            conversation_id=stream.conversation_id,
            audio_id=canceled.audio_id,
        )
        await self._send(stream.session_id, message.type, message.model_dump())
        self._sessions.record_interrupt(stream.session_id)

    async def deliver_session_end(self, stream: StreamIdentity) -> None:
        """Push that this voice session should end now."""
        message = VoiceSessionEnd(conversation_id=stream.conversation_id)
        await self._send(stream.session_id, message.type, message.model_dump())
        self._sessions.mark_tool_end(stream.session_id)

    def publish_schedule_category_updated(
        self, account_id: str, schedule_id: str, category: ScheduleCategory
    ) -> None:
        """Schedule a category-only push without coupling the business thread to asyncio."""
        message = ScheduleCategoryUpdated(
            payload=ScheduleCategoryUpdatedPayload(schedule_id=schedule_id, category=category)
        )
        # The classifier runs in a worker thread. The connection manager owns the
        # event-loop bridge and safely ignores the event when no session is connected.
        self._connections.publish_to_account_nowait(account_id, message.model_dump())

    async def _send(self, session_id: str, message_type: str, envelope: dict[str, object]) -> None:
        """Send one message, logging rather than raising when the session has gone."""
        if not await self._connections.send(session_id, envelope):
            logger.info(
                "dropped a result for a session that had gone",
                extra={"session_id": session_id, "message_type": message_type},
            )
