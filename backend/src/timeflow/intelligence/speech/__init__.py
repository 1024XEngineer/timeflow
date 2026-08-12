"""Provider-neutral speech synthesis interfaces."""

from timeflow.intelligence.speech.pipeline import (
    SpeechAudioChunk,
    SpeechAudioCompleted,
    SpeechAudioStarted,
    SpeechPipeline,
    SpeechPipelineEvent,
)
from timeflow.intelligence.speech.segmenter import TextSegmenter
from timeflow.intelligence.speech.tts import (
    SpeechPurpose,
    SpeechSegment,
    TtsAudioChunk,
    TtsCompleted,
    TtsConnectionError,
    TtsError,
    TtsEvent,
    TtsPort,
    TtsProtocolError,
    TtsSynthesisError,
)

__all__ = [
    "SpeechAudioChunk",
    "SpeechAudioCompleted",
    "SpeechAudioStarted",
    "SpeechPipeline",
    "SpeechPipelineEvent",
    "SpeechPurpose",
    "SpeechSegment",
    "TextSegmenter",
    "TtsAudioChunk",
    "TtsCompleted",
    "TtsConnectionError",
    "TtsError",
    "TtsEvent",
    "TtsPort",
    "TtsProtocolError",
    "TtsSynthesisError",
]
