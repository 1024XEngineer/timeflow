"""Result sink translating each of the agent's outlets into the protocol message for it."""

import logging
from collections.abc import AsyncIterator

from timeflow.gateway.websocket.agent_ports import (
    AudioReplyInfo,
    CommandOutcome,
    DialogueQuestionInfo,
    ReplyTextProgress,
    StreamIdentity,
    TranscriptResult,
)
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.messages.agent import (
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
    VoiceTtsEnd,
    VoiceTtsStart,
    VoiceTtsStartPayload,
)

logger = logging.getLogger(__name__)


def _question_kind(value: str) -> QuestionKind:
    """Narrow a producer's string to the protocol's four kinds, refusing anything else."""
    if value not in QUESTION_KINDS:
        raise ValueError(f"question_kind must be one of {QUESTION_KINDS}, got {value!r}")
    return value


class WebSocketResultSink:
    """Translate results into wire messages and push them to the session."""

    def __init__(self, connections: ConnectionManager) -> None:
        """Store the registry used to reach the session."""
        self._connections = connections

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
            ),
        )
        await self._send(stream.session_id, message.type, message.model_dump())

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

        delivered = await self._connections.stream_audio(
            stream.session_id, start.model_dump(), chunks, end.model_dump()
        )
        if not delivered:
            logger.info(
                "stopped speaking to a session that had gone",
                extra={"session_id": stream.session_id, "audio_id": reply.audio_id},
            )

    async def _send(self, session_id: str, message_type: str, envelope: dict[str, object]) -> None:
        """Send one message, logging rather than raising when the session has gone."""
        if not await self._connections.send(session_id, envelope):
            logger.info(
                "dropped a result for a session that had gone",
                extra={"session_id": session_id, "message_type": message_type},
            )
