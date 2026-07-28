"""HTTP contract tests for the health endpoint."""

from fastapi.testclient import TestClient

from timeflow.main import app


def test_health_endpoint() -> None:
    """The versioned health route returns the stable response contract."""
    response = TestClient(app).get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_unversioned_health_endpoint_is_not_exposed() -> None:
    """Routes outside the versioned API prefix remain unavailable."""
    response = TestClient(app).get("/health")

    assert response.status_code == 404
