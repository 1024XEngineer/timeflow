"""长任务拆分 Agent 的完整输入参数。"""

from typing import Any

from pydantic import BaseModel, Field

from timeapp.common.contracts.conversation import ConversationMessage


class TaskBreakdownInput(BaseModel):
    """长任务拆分所需的事实数据和画像上下文。"""

    raw_data: str | dict[str, Any]
    user_profile: dict[str, Any]
    task_profile: dict[str, Any] | None = None
    conversation: list[ConversationMessage] = Field(default_factory=list, max_length=20)
