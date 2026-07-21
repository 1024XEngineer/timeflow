"""Aggregate infrastructure and domain routers."""

from fastapi import APIRouter

from timeapp.agents.main_agent.router import router as main_agent_router
from timeapp.api.health import router as health_router
from timeapp.basic.identity.router import router as identity_router
from timeapp.basic.multimodal.router import router as multimodal_router
from timeapp.basic.reminders.router import router as reminders_router
from timeapp.basic.timeline.router import router as timeline_router
from timeapp.basic.usage_management.router import router as usage_management_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(main_agent_router)
api_router.include_router(identity_router)
api_router.include_router(timeline_router)
api_router.include_router(reminders_router)
api_router.include_router(multimodal_router)
api_router.include_router(usage_management_router)
