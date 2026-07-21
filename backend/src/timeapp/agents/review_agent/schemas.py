"""复盘 Agent 的完整输入参数。"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from timeapp.common.contracts.conversation import ConversationMessage


class ReviewInput(BaseModel):
    """指定时间范围的复盘事实数据。"""

    review_type: Literal["all_items", "long_goal"]
    range_start: datetime
    range_end: datetime
    related_data: list[dict[str, Any]]
    conversation: list[ConversationMessage] = Field(default_factory=list, max_length=20)
