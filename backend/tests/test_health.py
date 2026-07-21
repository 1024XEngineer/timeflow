"""Tests for the health-check endpoint."""

from fastapi.testclient import TestClient

from timeapp.main import app


def test_health_check() -> None:
    """健康检查不依赖数据库即可返回成功。"""

    with TestClient(app) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
