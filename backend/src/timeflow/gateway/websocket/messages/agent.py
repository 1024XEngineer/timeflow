"""Transcript and command result messages pushed after a stream ends."""

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
