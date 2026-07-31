"""Filesystem storage for the current reminder audio of each schedule."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from uuid import uuid4

from timeflow.business.reminders import ReminderAudio, ReminderAudioStoragePort


class FileReminderAudioStorage(ReminderAudioStoragePort):
    """Store one complete audio file per schedule with atomic replacement."""

    _AUDIO_SUFFIXES = ("wav", "mp3", "pcm", "audio")

    def __init__(self, base_dir: Path) -> None:
        self._base_dir = base_dir.expanduser().absolute()

    async def replace(self, schedule_id: str, audio: ReminderAudio) -> None:
        """Write a complete temporary file, then atomically replace the target."""
        await asyncio.to_thread(self._replace_sync, schedule_id, audio.data, audio.audio_format)

    async def read(self, schedule_id: str) -> ReminderAudio | None:
        """Read the current schedule audio and infer its transport format."""
        data = await asyncio.to_thread(self._read_sync, schedule_id)
        if data is None:
            return None
        return ReminderAudio(data=data, audio_format=self._detect_format(data))

    async def delete(self, schedule_id: str) -> None:
        """Delete the current audio file if it exists."""
        await asyncio.to_thread(self._delete_sync, schedule_id)

    def _replace_sync(self, schedule_id: str, data: bytes, audio_format: str) -> None:
        target = self._path_for(schedule_id, audio_format)
        self._base_dir.mkdir(parents=True, exist_ok=True)
        temporary = self._base_dir / f".{target.name}.{uuid4().hex}.tmp"
        try:
            temporary.write_bytes(data)
            os.replace(temporary, target)
            for path in self._paths_for(schedule_id):
                if path != target:
                    path.unlink(missing_ok=True)
        finally:
            temporary.unlink(missing_ok=True)

    def _read_sync(self, schedule_id: str) -> bytes | None:
        for path in self._paths_for(schedule_id):
            if path.is_file():
                return path.read_bytes()
        return None

    def _delete_sync(self, schedule_id: str) -> None:
        for path in self._paths_for(schedule_id):
            path.unlink(missing_ok=True)

    def _path_for(self, schedule_id: str, audio_format: str) -> Path:
        if (
            not schedule_id
            or schedule_id in {".", ".."}
            or "/" in schedule_id
            or "\\" in schedule_id
        ):
            raise ValueError("invalid schedule ID for reminder audio path")
        normalized_format = audio_format.strip().lower()
        if normalized_format not in self._AUDIO_SUFFIXES:
            raise ValueError("unsupported reminder audio format")
        return self._base_dir / f"{schedule_id}.{normalized_format}"

    def _paths_for(self, schedule_id: str) -> tuple[Path, ...]:
        return tuple(self._path_for(schedule_id, suffix) for suffix in self._AUDIO_SUFFIXES)

    @staticmethod
    def _detect_format(data: bytes) -> str:
        if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
            return "wav"
        if data.startswith(b"ID3") or data[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
            return "mp3"
        return "wav"


__all__ = ["FileReminderAudioStorage"]
