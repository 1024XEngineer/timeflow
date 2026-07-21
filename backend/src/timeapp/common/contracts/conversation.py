"""跨 Agent 共享的对话消息结构。"""

from typing import Literal

from pydantic import BaseModel


class ConversationMessage(BaseModel):
    """一条用于上下文聚合的对话记录。"""

    role: Literal["system", "user", "assistant"]
    content: str
    message_id: str | None = None
