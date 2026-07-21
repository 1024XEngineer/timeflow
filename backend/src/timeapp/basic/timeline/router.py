"""时间顺序事项展示基础业务路由。"""

from fastapi import APIRouter

router = APIRouter(prefix="/unified-items", tags=["basic-timeline"])
