"""应用组合根的安全装配测试。"""

import os
from collections.abc import AsyncIterator
from typing import Any
from unittest import mock

import pytest
from auth_test_support import (
    TEST_JWT_ENVIRONMENT,
    TEST_JWT_SECRET,
    build_test_token_service,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event

from timeflow.business.auth import AuthAccessResult
from timeflow.gateway.websocket.ports import StreamContext
from timeflow.infrastructure.settings import get_settings
from timeflow.main import create_app


class _Sink:
    """装配测试不会使用的空音频接收器。"""

    async def consume(
        self,
        chunks: AsyncIterator[bytes],
        stream: StreamContext,
    ) -> None:
        """消费输入但不产生外部副作用。"""
        async for _chunk in chunks:
            pass


class _UnusedAuthAccess:
    """隔离数据库装配，使测试只关注安全组件。"""

    def access(self, username: str, password: str) -> AuthAccessResult:
        """这些装配测试不应调用账户访问用例。"""
        raise AssertionError(f"unexpected auth access for {username!r} and password")


class _FakeAsyncClient:
    """记录 aclose() 是否被调用，不真的打开网络连接。"""

    def __init__(self, *, timeout: float) -> None:
        self.timeout = timeout
        self.closed = False

    async def aclose(self) -> None:
        """记录关闭。"""
        self.closed = True


def _tencent_environment() -> dict[str, str]:
    """腾讯地图凭据就绪时的最小环境变量集合。"""
    return {
        "TIMEFLOW_TENCENT_MAP_KEY": "key-for-test",
        "TIMEFLOW_TENCENT_MAP_BASE_URL": "https://apis.map.qq.com",
    }


def _build_with_environment(
    environment: str,
    *,
    jwt_secret: str = TEST_JWT_SECRET,
    cors_allowed_origins: str = "",
    audio_configured: bool = False,
    voice_agent_mode: str = "1",
    **injected: Any,
) -> FastAPI:
    """固定外部环境后构建应用，避免本机配置改变断言含义。"""
    credentials = (
        {
            "TIMEFLOW_ALIYUN_AUDIO_API_KEY": "key-for-test",
            "TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID": "ws-for-test",
        }
        if audio_configured
        else {
            "TIMEFLOW_ALIYUN_AUDIO_API_KEY": "",
            "TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID": "",
        }
    )
    environment_values = {
        **TEST_JWT_ENVIRONMENT,
        "TIMEFLOW_ENVIRONMENT": environment,
        "TIMEFLOW_JWT_SECRET": jwt_secret,
        "TIMEFLOW_CORS_ALLOWED_ORIGINS": cors_allowed_origins,
        "TIMEFLOW_VOICE_AGENT_MODE": voice_agent_mode,
        **credentials,
    }
    get_settings.cache_clear()
    try:
        with mock.patch.dict(os.environ, environment_values, clear=False):
            auth_access = injected.pop("auth_access", _UnusedAuthAccess())
            return create_app(auth_access=auth_access, **injected)
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize("jwt_secret", ["", "too-short"])
def test_build_rejects_an_empty_or_weak_default_jwt_secret(jwt_secret: str) -> None:
    """空或弱密钥不能构建 HTTP 与 WebSocket 共用的 JWT 服务。"""
    with pytest.raises(ValueError, match="JWT secret must be at least 32 UTF-8 bytes"):
        _build_with_environment(
            "development",
            jwt_secret=jwt_secret,
            audio_sink=_Sink(),
        )


def test_injected_token_service_is_shared_by_http_and_websocket() -> None:
    """显式注入的真实令牌服务同时供 HTTP 与 WebSocket 使用。"""
    tokens = build_test_token_service()
    issued = tokens.issue("acc_shared")
    application = _build_with_environment(
        "development",
        jwt_secret="",
        access_token_service=tokens,
        audio_sink=_Sink(),
    )

    with TestClient(application) as client:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(
                {
                    "type": "session.hello",
                    "payload": {
                        "access_token": issued.access_token,
                        "device_id": "device_001",
                    },
                }
            )
            assert websocket.receive_json()["type"] == "session.ready"

    dependency = application.state.authenticated_account_dependency
    assert dependency(f"Bearer {issued.access_token}").account_id == "acc_shared"


def test_building_in_development_still_works_without_a_real_model() -> None:
    """开发环境没有外部模型时仍可使用显式的测试音频接收器。"""
    assert _build_with_environment("development", audio_sink=_Sink()) is not None


def test_configured_cors_origin_allows_expo_web_authentication() -> None:
    """浏览器预检只允许显式配置的 Expo Web 来源。"""
    application = _build_with_environment(
        "development",
        audio_sink=_Sink(),
        cors_allowed_origins="http://localhost:8081",
    )

    with TestClient(application) as client:
        allowed = client.options(
            "/api/v1/auth/access",
            headers={
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Method": "POST",
                "Origin": "http://localhost:8081",
            },
        )
        rejected = client.options(
            "/api/v1/auth/access",
            headers={
                "Access-Control-Request-Method": "POST",
                "Origin": "https://unconfigured.example.com",
            },
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:8081"
    assert "access-control-allow-origin" not in rejected.headers


def test_production_without_a_real_audio_sink_fails_closed() -> None:
    """生产环境缺少实时模型配置时拒绝空音频实现。"""
    with pytest.raises(RuntimeError, match="development-only"):
        _build_with_environment("production")


def test_production_builds_with_an_injected_audio_sink() -> None:
    """生产环境显式注入音频接收器后可完成装配。"""
    application = _build_with_environment("production", audio_sink=_Sink())

    assert application is not None


def test_production_websocket_rejects_a_non_jwt_token() -> None:
    """生产 WebSocket 只接受共享真实 JWT 服务签发的令牌。"""
    application = _build_with_environment("production", audio_sink=_Sink())

    with TestClient(application) as client:
        with client.websocket_connect("/ws?device_id=device_001") as websocket:
            websocket.send_json(
                {
                    "type": "session.hello",
                    "request_id": "req_production_auth",
                    "payload": {
                        "access_token": "arbitrary-non-jwt-token",
                        "device_id": "device_001",
                    },
                }
            )
            rejected = websocket.receive_json()
            closed = websocket.receive()

    assert rejected["error"]["code"] == "UNAUTHENTICATED"
    assert closed == {"type": "websocket.close", "code": 1008, "reason": ""}


def test_configured_realtime_model_lets_production_build() -> None:
    """实时模型凭据完整时无需手工注入音频接收器。"""
    application = _build_with_environment("production", audio_configured=True)

    assert application is not None


def test_voice_agent_mode_two_fails_closed_until_conversation_agent_is_wired() -> None:
    """未实现 Agent 端口前，不能静默选择 LLM+ASR+TTS 模式。"""
    with pytest.raises(RuntimeError, match="TIMEFLOW_VOICE_AGENT_MODE=2"):
        _build_with_environment("development", voice_agent_mode="2")


def test_lifespan_disposes_the_database_engine_owned_by_the_application() -> None:
    """应用关闭时释放由组合根创建的数据库引擎。"""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    disposed: list[bool] = []
    event.listen(engine, "engine_disposed", lambda _engine: disposed.append(True))

    with mock.patch("timeflow.main.build_engine", return_value=engine):
        application = _build_with_environment(
            "development",
            auth_access=None,
            audio_sink=_Sink(),
        )

    with TestClient(application):
        assert disposed == []

    assert disposed == [True]


def test_lifespan_does_not_dispose_an_injected_database_engine() -> None:
    """外部注入的数据库引擎仍由调用方管理生命周期。"""
    engine = create_engine("sqlite+pysqlite:///:memory:")
    disposed: list[bool] = []
    event.listen(engine, "engine_disposed", lambda _engine: disposed.append(True))
    application = _build_with_environment(
        "development",
        auth_access=None,
        engine=engine,
        audio_sink=_Sink(),
    )

    with TestClient(application):
        pass

    assert disposed == []
    engine.dispose()


def test_building_with_tencent_and_aliyun_configured_wires_location() -> None:
    """腾讯地图和实时模型凭据都配置齐全时，组合根能正常装配位置检索能力。"""
    with mock.patch.dict(os.environ, _tencent_environment(), clear=False):
        application = _build_with_environment("production", audio_configured=True)

    assert application is not None


def test_lifespan_closes_the_owned_tencent_http_client() -> None:
    """应用关闭时释放组合根为地图检索创建的 HTTP client，跟数据库引擎释放同一套时机。"""
    client = _FakeAsyncClient(timeout=5.0)
    engine = create_engine("sqlite+pysqlite:///:memory:")

    with (
        mock.patch("timeflow.main.httpx.AsyncClient", return_value=client) as factory,
        mock.patch.dict(os.environ, _tencent_environment(), clear=False),
    ):
        application = _build_with_environment("development", auth_access=None, engine=engine)

    factory.assert_called_once()
    with TestClient(application):
        assert client.closed is False

    assert client.closed is True


def test_voice_agent_mode_two_never_opens_a_tencent_http_client() -> None:
    """mode=2 在能建出 Agent 之前就已失败，不该先泄漏一个没人关闭的 HTTP client。"""
    with (
        mock.patch("timeflow.main.httpx.AsyncClient") as factory,
        mock.patch.dict(os.environ, _tencent_environment(), clear=False),
        pytest.raises(RuntimeError, match="TIMEFLOW_VOICE_AGENT_MODE=2"),
    ):
        _build_with_environment("development", voice_agent_mode="2")

    factory.assert_not_called()
