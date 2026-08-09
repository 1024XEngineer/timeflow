"""Result sink that pushes a completed turn to the client.

A turn arrives from the agent after `voice.stream.end` has already been answered, so
these messages are pushed rather than returned as replies. They go out in order, one
send at a time, because each send takes the session write lock separately.
"""

import logging

from timeflow.gateway.websocket.agent_ports import TurnResult
from timeflow.gateway.websocket.connection_manager import ConnectionManager
from timeflow.gateway.websocket.messages.agent import (
    VoiceAsrCompleted,
    VoiceAsrCompletedPayload,
    VoiceCommandResult,
    VoiceCommandResultPayload,
)

logger = logging.getLogger(__name__)


class WebSocketResultSink:
    """Translate a turn into wire messages and push them to the session."""

    def __init__(self, connections: ConnectionManager) -> None:
        """Store the registry used to reach the session."""
        self._connections = connections

    async def deliver(self, result: TurnResult) -> None:
        """Push the transcript, then the command result, in that order."""
        session_id = result.stream.session_id

        transcript = VoiceAsrCompleted(
            request_id=result.stream.request_id,
            conversation_id=result.stream.conversation_id,
            payload=VoiceAsrCompletedPayload(
                transcript=result.transcript.text,
                language=result.transcript.language,
                duration_ms=result.transcript.duration_ms,
            ),
        )
        command = VoiceCommandResult(
            message_id=result.message_id,
            request_id=result.stream.request_id,
            conversation_id=result.stream.conversation_id,
            payload=VoiceCommandResultPayload(
                operation=result.operation,
                status=result.status,
                schedule=result.schedule,
            ),
        )

        for message in (transcript, command):
            if not await self._connections.send(session_id, message.model_dump()):
                logger.info(
                    "dropped a turn result for a session that had gone",
                    extra={"session_id": session_id, "message_type": message.type},
                )
                return
