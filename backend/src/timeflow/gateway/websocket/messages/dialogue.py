"""What the assistant says back: its wording as it forms, and the questions it asks."""

from typing import Any, Literal, get_args

from pydantic import BaseModel

# The interface design's four reasons for asking; a client has no branch for any other.
QuestionKind = Literal["missing_field", "ambiguous_target", "recurrence_scope", "confirmation"]
QUESTION_KINDS: tuple[QuestionKind, ...] = get_args(QuestionKind)


class VoiceDialogueReplyPayload(BaseModel):
    """The reply's wording so far, and whether more is coming."""

    reply_id: str
    speech_text: str
    done: bool = False


class VoiceDialogueReply(BaseModel):
    """Server message carrying the assistant's own words, ahead of speaking them."""

    type: Literal["voice.dialogue.reply"] = "voice.dialogue.reply"
    request_id: str | None = None
    conversation_id: str
    payload: VoiceDialogueReplyPayload


class VoiceDialogueQuestionPayload(BaseModel):
    """What is being asked, and what kind of answer would settle it."""

    question_id: str
    question_kind: QuestionKind
    speech_text: str
    required_response: str | None = None
    candidates: list[dict[str, Any]] = []


class VoiceDialogueQuestion(BaseModel):
    """Server message asking the user for one more thing before acting."""

    type: Literal["voice.dialogue.question"] = "voice.dialogue.question"
    request_id: str | None = None
    conversation_id: str
    payload: VoiceDialogueQuestionPayload
