"""Audio stream lifecycle messages (architecture design sections 5.2 and 5.3)."""

from typing import Literal

from pydantic import BaseModel


class VoiceStreamStartPayload(BaseModel):
    """Audio format the client is about to send."""

    conversation_id: str | None = None
    audio_format: str
    sample_rate_hz: int
    channels: int


class VoiceStreamStart(BaseModel):
    """Client request that opens an audio stream."""

    type: Literal["voice.stream.start"]
    request_id: str | None = None
    payload: VoiceStreamStartPayload


class VoiceStreamStartedPayload(BaseModel):
    """Identifiers assigned to an accepted audio stream."""

    stream_id: str
    conversation_id: str


class VoiceStreamStarted(BaseModel):
    """Server acknowledgement that binary frames may now be sent."""

    type: Literal["voice.stream.started"] = "voice.stream.started"
    request_id: str | None = None
    ok: Literal[True] = True
    payload: VoiceStreamStartedPayload


class VoiceStreamEndPayload(BaseModel):
    """Stream the client is closing."""

    stream_id: str


class VoiceStreamEnd(BaseModel):
    """Client request that closes an audio stream."""

    type: Literal["voice.stream.end"]
    request_id: str | None = None
    payload: VoiceStreamEndPayload
