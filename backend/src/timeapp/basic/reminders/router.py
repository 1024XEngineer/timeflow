"""提醒基础业务路由。"""

from fastapi import APIRouter

router = APIRouter(prefix="/reminders", tags=["basic-reminders"])
