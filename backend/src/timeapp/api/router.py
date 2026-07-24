"""Aggregate infrastructure and domain routers."""

from fastapi import APIRouter

from timeapp.api.health import router as health_router
from timeapp.basic.identity.router import router as identity_router
from timeapp.basic.usage_management.router import router as usage_management_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(identity_router)
api_router.include_router(usage_management_router)
