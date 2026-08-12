"""Incremental text segmentation for low-latency speech synthesis."""

from __future__ import annotations

_STRONG_BOUNDARIES = frozenset("。！？；\n.?!;")
_WEAK_BOUNDARIES = frozenset("，、：,:")


class TextSegmenter:
    """Buffer text deltas and emit natural, bounded speech segments."""

    def __init__(self, *, target_length: int = 20, max_length: int = 120) -> None:
        if target_length <= 0:
            raise ValueError("target_length must be positive")
        if max_length < target_length:
            raise ValueError("max_length must be at least target_length")
        self._target_length = target_length
        self._max_length = max_length
        self._buffer = ""

    def push(self, text: str) -> tuple[str, ...]:
        """Append one text delta and return every newly complete segment."""
        if not text:
            return ()
        self._buffer += text
        segments: list[str] = []

        while True:
            strong = self._strong_cut()
            if strong is not None:
                segment = self._take(strong)
                if segment:
                    segments.append(segment)
                continue
            if len(self._buffer) <= self._max_length:
                break
            segment = self._take(self._overflow_cut())
            if segment:
                segments.append(segment)

        return tuple(segments)

    def flush(self) -> str | None:
        """Return the remaining text and clear the buffer."""
        segment = self._buffer.strip()
        self._buffer = ""
        return segment or None

    def _strong_cut(self) -> int | None:
        for index, character in enumerate(self._buffer):
            if character in _STRONG_BOUNDARIES:
                return index + 1
        return None

    def _overflow_cut(self) -> int:
        limit = min(len(self._buffer), self._max_length)
        for index in range(limit - 1, self._target_length - 1, -1):
            if self._buffer[index] in _WEAK_BOUNDARIES:
                return index + 1
        return limit

    def _take(self, cut: int) -> str:
        segment = self._buffer[:cut].strip()
        self._buffer = self._buffer[cut:].lstrip()
        return segment
