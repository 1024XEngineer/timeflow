"""Result sink that pushes transcripts, command results and spoken replies to the client."""

import logging
from collections.abc import AsyncIterator

from timeflow.gateway.websocket.agent_ports import (
    AudioReplyInfo,
    CommandOutcome,
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
from timeflow.gateway.websocket.messages.tts import (
    VoiceTtsEnd,
    VoiceTtsStart,
    VoiceTtsStartPayload,
)

logger = logging.getLogger(__name__)


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
