"""What the assistant says back: its wording as it forms, and the questions it asks."""

from typing import Any, Literal

from pydantic import BaseModel


class VoiceDialogueReplyPayload(BaseModel):
    """The reply's wording so far, and whether more is coming."""

    reply_id: str
    speech_text: str
    done: bool = False


class VoiceDialogueReply(BaseModel):
    """Server message carrying the assistant's own words, ahead of speaking them.

    Not defined by the interface design, which gives the assistant's wording only one home
    -- the speech_text of a question. A plain answer has nowhere to go but the opening
    message of its audio, and that cannot be sent until audio exists. Where speech is
    synthesized from a language model's output, the sentence is finished well before its
    first byte of audio is, so binding the two costs the client that whole gap.
    """

    type: Literal["voice.dialogue.reply"] = "voice.dialogue.reply"
    request_id: str | None = None
    conversation_id: str
    payload: VoiceDialogueReplyPayload


class VoiceDialogueQuestionPayload(BaseModel):
    """What is being asked, and what kind of answer would settle it."""

    question_id: str
    question_kind: str
    speech_text: str
    required_response: str | None = None
    candidates: list[dict[str, Any]] = []


class VoiceDialogueQuestion(BaseModel):
    """Server message asking the user for one more thing before acting.

    Carries no message_id: the interface design gives one only to results the client has
    to acknowledge, and a question is answered by speaking, not by an ack.
    """

    type: Literal["voice.dialogue.question"] = "voice.dialogue.question"
    request_id: str | None = None
    conversation_id: str
    payload: VoiceDialogueQuestionPayload
