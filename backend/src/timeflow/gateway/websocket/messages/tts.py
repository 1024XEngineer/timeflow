"""Spoken reply messages (architecture design section 5.8).

The pair frames a run of bare audio binary frames: everything between a start and its
matching end belongs to that reply. The frames carry no identifier of their own, so this
framing is the only thing that assigns them, and `audio_id` lets a client tell one reply
from the next.

Like the dialogue result messages, the identifiers sit beside `payload` rather than inside
it, and neither message carries `ok`.
"""

from typing import Literal

from pydantic import BaseModel

PURPOSE_DIALOGUE_QUESTION = "dialogue_question"
PURPOSE_COMMAND_RESULT = "command_result"
PURPOSE_REMINDER = "reminder"


class VoiceTtsStartPayload(BaseModel):
    """Format of the audio about to be sent, and what it is being sent for."""

    format: str
    sample_rate_hz: int
    purpose: str
    schedule_id: str | None = None
    audio_version: int | None = None


class VoiceTtsStart(BaseModel):
    """Server message announcing that audio frames follow."""

    type: Literal["voice.tts.start"] = "voice.tts.start"
    conversation_id: str
    audio_id: str
    payload: VoiceTtsStartPayload


class VoiceTtsEnd(BaseModel):
    """Server message closing a run of audio frames."""

    type: Literal["voice.tts.end"] = "voice.tts.end"
    conversation_id: str
    audio_id: str
