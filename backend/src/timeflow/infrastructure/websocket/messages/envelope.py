"""所有 `*.error` 消息共用的错误详情结构。"""

from typing import Any

from pydantic import BaseModel


class ErrorDetail(BaseModel):
    """错误码、说明和上下文,所有 `*.error` 消息的 `error` 字段共用这个形状。"""

    code: str
    message: str
    details: dict[str, Any] | None = None
