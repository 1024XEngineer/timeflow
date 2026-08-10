"""Spoken reply messages framing a run of audio frames."""

from typing import Literal

from pydantic import BaseModel

PURPOSE_DIALOGUE_QUESTION = "dialogue_question"
PURPOSE_COMMAND_RESULT = "command_result"
PURPOSE_REMINDER = "reminder"


class VoiceTtsStartPayload(BaseModel):
    """Format of the audio about to be sent, what it says, and what it is being sent for."""

    format: str
    sample_rate_hz: int
    purpose: str
    speech_text: str
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
