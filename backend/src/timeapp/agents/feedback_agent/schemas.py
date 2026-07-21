"""反馈 Agent 的完整输入参数。"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from timeapp.common.contracts.conversation import ConversationMessage


class FeedbackInput(BaseModel):
    """用于定位事项并规范化反馈的候选数据。"""

    raw_input: str
    range_start: datetime
    range_end: datetime
    related_items: list[dict[str, Any]]
    conversation: list[ConversationMessage] = Field(default_factory=list, max_length=20)
