"""HTTP contract tests for the health and metrics endpoints."""

from fastapi.testclient import TestClient

from timeflow.main import _database_readiness, app


def test_health_endpoint() -> None:
    """The versioned health route returns liveness plus bounded dependency checks."""
    response = TestClient(app).get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    checks = body["checks"]
    assert checks["process"] == "ok"
    assert checks["database"] in {"ok", "error", "skipped"}
    assert checks["asr"] in {"configured", "unconfigured"}
    assert checks["llm"] in {"configured", "unconfigured"}
    assert checks["tts"] in {"configured", "unconfigured"}
    assert checks["realtime"] in {"configured", "unconfigured"}
    assert checks["maps"] in {"configured", "unconfigured"}


def test_metrics_endpoint_exposes_prometheus_text() -> None:
    """GET /metrics is the Prometheus scrape surface for gateway and infrastructure."""
    client = TestClient(app)
    client.get("/api/v1/health")
    response = client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    text = response.text
    assert "timeflow_http_requests_total" in text
    assert "timeflow_health_liveness_total" in text
    assert "/api/v1/health" in text


def test_database_readiness_is_skipped_without_an_engine() -> None:
    assert _database_readiness(None) == "skipped"


def test_unversioned_health_endpoint_is_not_exposed() -> None:
    """Routes outside the versioned API prefix remain unavailable."""
    response = TestClient(app).get("/health")

    assert response.status_code == 404
