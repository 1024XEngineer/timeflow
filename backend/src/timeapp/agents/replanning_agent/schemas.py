"""重排 Agent 的完整输入参数。"""

from typing import Any

from pydantic import BaseModel, Field

from timeapp.common.contracts.conversation import ConversationMessage


class ReplanningInput(BaseModel):
    """整体重排所需的未来事项和画像上下文。"""

    raw_data: str | dict[str, Any]
    user_profile: dict[str, Any]
    task_profile: dict[str, Any] | None = None
    future_items: list[dict[str, Any]]
    incomplete_goal_items: list[dict[str, Any]]
    conversation: list[ConversationMessage] = Field(default_factory=list, max_length=20)
