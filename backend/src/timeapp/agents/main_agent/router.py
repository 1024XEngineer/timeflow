"""主 Agent 的 HTTP 边界。具体编排逻辑不放在路由层。"""

from fastapi import APIRouter

router = APIRouter(prefix="/main-agent", tags=["main-agent"])
