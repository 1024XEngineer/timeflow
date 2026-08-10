"""Result sink that pushes transcripts and command results to the client."""

import logging

from timeflow.gateway.websocket.agent_ports import (
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

    async def _send(self, session_id: str, message_type: str, envelope: dict[str, object]) -> None:
        """Send one message, logging rather than raising when the session has gone."""
        if not await self._connections.send(session_id, envelope):
            logger.info(
                "dropped a result for a session that had gone",
                extra={"session_id": session_id, "message_type": message_type},
            )
