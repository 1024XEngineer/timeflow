"""Dialogue result messages (architecture design sections 5.3 and 5.5).

These follow the shapes the architecture design gives literally, which differ from the
stream lifecycle messages in two ways: the identifiers sit beside `payload` rather than
inside it, and there is no `ok` field. `message.ack` carries no payload at all.
"""

from typing import Any, Literal

from pydantic import BaseModel


class VoiceAsrCompletedPayload(BaseModel):
    """What the user was heard to say."""

    transcript: str
    language: str
    duration_ms: int


class VoiceAsrCompleted(BaseModel):
    """Server message carrying the final transcript of a stream."""

    type: Literal["voice.asr.completed"] = "voice.asr.completed"
    request_id: str | None = None
    conversation_id: str
    payload: VoiceAsrCompletedPayload


class VoiceCommandResultPayload(BaseModel):
    """The command that was carried out and the schedule it produced."""

    operation: str
    status: str
    schedule: dict[str, Any]


class VoiceCommandResult(BaseModel):
    """Server message carrying a committed command result."""

    type: Literal["voice.command.result"] = "voice.command.result"
    message_id: str
    request_id: str | None = None
    conversation_id: str
    payload: VoiceCommandResultPayload


class MessageAck(BaseModel):
    """Client confirmation that a command result was applied locally."""

    type: Literal["message.ack"]
    message_id: str
    status: str
