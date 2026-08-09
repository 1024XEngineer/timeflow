"""Audio sink that drains a stream without interpreting it.

Placeholder until the dialogue engine lands: it proves the transport delivers every byte
in order while the engine that will consume them does not exist yet. It satisfies the
transport's sink port structurally and does not import the gateway.
"""

import logging
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)


class NullAudioSink:
    """Drain each stream and log how many bytes arrived."""

    async def consume(self, chunks: AsyncIterator[bytes], stream: Any) -> None:
        """Drain the stream, logging how many bytes arrived."""
        byte_count = 0
        async for chunk in chunks:
            byte_count += len(chunk)

        logger.info(
            "audio stream drained",
            extra={"stream_id": stream.stream_id, "byte_count": byte_count},
        )
