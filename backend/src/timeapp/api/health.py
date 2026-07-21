"""Infrastructure health-check routes."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel


class HealthResponse(BaseModel):
    """健康检查响应。"""

    status: Literal["ok"] = "ok"


router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """报告应用进程可用。"""

    return HealthResponse()
