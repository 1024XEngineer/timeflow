"""认证适配器共用的脱敏异常诊断工具。"""

import logging
import os
from collections import deque
from traceback import walk_tb
from uuid import uuid4


def log_sanitized_exception(
    logger: logging.Logger,
    error: Exception,
    *,
    event_prefix: str,
    error_code: str,
    message: str,
    status_code: int | None = None,
) -> str:
    """记录不含凭据和异常文本的诊断信息，并返回关联事件 ID。"""
    event_id = f"{event_prefix}_{uuid4().hex}"
    frames: deque[dict[str, str | int]] = deque(maxlen=8)
    for frame, line_number in walk_tb(error.__traceback__):
        frames.append(
            {
                "filename": os.path.basename(frame.f_code.co_filename),
                "lineno": line_number,
                "function": frame.f_code.co_name,
            }
        )

    extra: dict[str, object] = {
        "event_id": event_id,
        "error_code": error_code,
        "exception_module": type(error).__module__,
        "exception_type": type(error).__qualname__,
        "traceback_frames": list(frames),
    }
    if status_code is not None:
        extra["status_code"] = status_code
    logger.error(message, extra=extra)
    return event_id


__all__ = ["log_sanitized_exception"]
