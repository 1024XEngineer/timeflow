"""Tests for the Aliyun Qwen-Audio-TTS gateway."""

import asyncio
import json

import httpx
import pytest

from timeflow.gateway.aliyun_tts import AliyunTTSClient, AliyunTTSClientError


class SettingsStub:
    api_url = "https://workspace.example.test/api/v1/services/audio/tts/SpeechSynthesizer"
    api_key = "tts-key"
    model = "qwen-audio-3.0-tts-flash"
    voice = "longanhuan_v3.6"
    audio_format = "wav"
    sample_rate_hz = 24000
    timeout_seconds = 5.0


def test_aliyun_tts_posts_documented_payload_and_downloads_audio() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            assert request.url == SettingsStub.api_url
            assert request.headers["Authorization"] == "Bearer tts-key"
            assert json.loads(request.content) == {
                "model": "qwen-audio-3.0-tts-flash",
                "input": {
                    "text": "您有一个日程，十五分钟后，开会。",
                    "voice": "longanhuan_v3.6",
                    "format": "wav",
                    "sample_rate": 24000,
                },
            }
            return httpx.Response(
                200,
                json={"output": {"audio": {"url": "https://signed.example.test/a.wav"}}},
                request=request,
            )
        return httpx.Response(
            200,
            content=b"RIFFaudio",
            headers={"Content-Type": "audio/wav"},
            request=request,
        )

    async def scenario() -> None:
        client = AliyunTTSClient(SettingsStub(), transport=httpx.MockTransport(handler))
        audio = await client.synthesize("您有一个日程，十五分钟后，开会。")
        await client.aclose()

        assert audio.data == b"RIFFaudio"
        assert audio.audio_format == "wav"
        assert [request.method for request in requests] == ["POST", "GET"]

    asyncio.run(scenario())


def test_aliyun_tts_rejects_missing_audio_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output": {}}, request=request)

    async def scenario() -> None:
        client = AliyunTTSClient(SettingsStub(), transport=httpx.MockTransport(handler))
        with pytest.raises(AliyunTTSClientError, match="output.audio.url"):
            await client.synthesize("提醒")
        await client.aclose()

    asyncio.run(scenario())


def test_aliyun_tts_defers_missing_api_key_to_request() -> None:
    class MissingKeySettings(SettingsStub):
        api_key = ""

    async def scenario() -> None:
        client = AliyunTTSClient(MissingKeySettings())
        with pytest.raises(AliyunTTSClientError, match="API key is not configured"):
            await client.synthesize("提醒")

    asyncio.run(scenario())


def test_aliyun_tts_rejects_workspace_placeholder() -> None:
    class PlaceholderSettings(SettingsStub):
        api_url = (
            "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/"
            "api/v1/services/audio/tts/SpeechSynthesizer"
        )

    async def scenario() -> None:
        client = AliyunTTSClient(PlaceholderSettings())
        with pytest.raises(AliyunTTSClientError, match="WorkspaceId"):
            await client.synthesize("提醒")

    asyncio.run(scenario())
