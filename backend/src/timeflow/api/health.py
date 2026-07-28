"""Service health HTTP endpoint."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from timeflow.api.dependencies import get_health_service
from timeflow.business.health import HealthService

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Health response contract."""

    status: Literal["ok"]


@router.get("/health", response_model=HealthResponse)
def health(
    service: Annotated[HealthService, Depends(get_health_service)],
) -> HealthResponse:
    """Return the deterministic liveness status."""
    result = service.check()
    return HealthResponse(status=result.status)
