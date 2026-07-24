"""应用使用管理基础业务路由。"""

from fastapi import APIRouter

router = APIRouter(prefix="/usage-management", tags=["basic-usage-management"])
