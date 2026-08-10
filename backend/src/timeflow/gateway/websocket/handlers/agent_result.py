"""Result sink that pushes what the agent produced to the client.

Results arrive after `voice.stream.end` has already been answered, so these messages are
pushed rather than returned as replies. There is one method per protocol message, and the
agent calls each as soon as that piece is known -- the transcript need not wait for the
command to finish. Each send takes the session write lock on its own, so a message can go
out even while other work on the session is still in progress.
"""

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
