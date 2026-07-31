#!/usr/bin/env python3
"""Smoke test for Aliyun Qwen-Audio-TTS synthesis."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
from pathlib import Path
from time import perf_counter

from timeflow.gateway.aliyun_tts import AliyunTTSClient, AliyunTTSClientError
from timeflow.infrastructure.settings import Settings

DEFAULT_TEXT = "您已到达目标地点附近，别忘了领取预约的体检报告。"


def parse_args() -> argparse.Namespace:
    """Parse optional smoke-test text and output path."""
    parser = argparse.ArgumentParser(
        description="Call Aliyun Qwen-Audio-TTS once and save the audio"
    )
    parser.add_argument("--text", default=DEFAULT_TEXT, help="Text sent to the TTS model")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Audio output directory; defaults to backend/.data/tts-smoke",
    )
    return parser.parse_args()


async def run(text: str, output_dir: Path | None) -> Path:
    """Call the configured TTS model and persist the returned audio bytes."""
    backend_root = Path(__file__).resolve().parents[1]
    settings = Settings.from_environment(backend_root / ".env")
    if not settings.aliyun_tts.api_key:
        raise SystemExit("TIMEFLOW_ALIYUN_TTS_API_KEY is empty in backend/.env")

    target_dir = output_dir or backend_root / ".data" / "tts-smoke"
    client = AliyunTTSClient(settings.aliyun_tts)
    started_at = perf_counter()
    try:
        audio = await client.synthesize(text)
    except AliyunTTSClientError as exc:
        elapsed = perf_counter() - started_at
        raise SystemExit(f"TTS failed after {elapsed:.3f}s: {exc}") from exc
    finally:
        await client.aclose()

    elapsed = perf_counter() - started_at
    target_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = target_dir / f"tts_smoke_{timestamp}.{audio.audio_format}"
    output_path.write_bytes(audio.data)

    print(f"Model: {settings.aliyun_tts.model}")
    print(f"Voice: {settings.aliyun_tts.voice}")
    print(f"Text: {text}")
    print(f"Audio format: {audio.audio_format}")
    print(f"Audio size: {len(audio.data)} bytes")
    print(f"Elapsed: {elapsed:.3f}s")
    print(f"Saved to: {output_path}")
    return output_path


async def main() -> None:
    """Run one command-line smoke test."""
    args = parse_args()
    await run(args.text, args.output_dir)


if __name__ == "__main__":
    asyncio.run(main())
