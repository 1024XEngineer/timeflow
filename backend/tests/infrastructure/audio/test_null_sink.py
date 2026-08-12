"""The placeholder audio sink that drains a stream and keeps nothing."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

from timeflow.infrastructure.audio.null_sink import NullAudioSink


@dataclass
class _Stream:
    stream_id: str = "stream-1"


async def _chunks(payloads: list[bytes]) -> AsyncIterator[bytes]:
    for payload in payloads:
        yield payload


def test_a_drained_stream_is_counted_and_discarded(
    caplog: logging.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO):
        asyncio.run(NullAudioSink().consume(_chunks([b"ab", b"cde"]), _Stream()))

    (record,) = [r for r in caplog.records if r.message == "audio stream drained"]
    assert record.byte_count == 5
    assert record.stream_id == "stream-1"


def test_a_stream_that_carried_nothing_still_reports_zero(
    caplog: logging.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.INFO):
        asyncio.run(NullAudioSink().consume(_chunks([]), _Stream()))

    (record,) = [r for r in caplog.records if r.message == "audio stream drained"]
    assert record.byte_count == 0
