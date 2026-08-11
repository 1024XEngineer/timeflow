"""Spoken reply messages framing a run of audio frames."""

from typing import Literal

from pydantic import BaseModel

# The protocol allows dialogue_question and reminder too; both belong to rounds that do
# not exist yet, and a reminder additionally requires schedule_id and audio_version.
PURPOSE_COMMAND_RESULT = "command_result"


class VoiceTtsStartPayload(BaseModel):
    """Format of the audio about to be sent, what it says, and what it is being sent for."""

    format: str
    sample_rate_hz: int
    purpose: str
    # Empty when the wording already went out through voice.dialogue.reply.
    speech_text: str = ""
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
