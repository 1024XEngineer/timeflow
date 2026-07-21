"""日程待办 Agent 的完整输入参数。"""

from pydantic import BaseModel, Field

from timeapp.common.contracts.conversation import ConversationMessage


class ScheduleTodoInput(BaseModel):
    """主 Agent 完成参数补全后传入的日程待办上下文。"""

    raw_input: str
    conversation: list[ConversationMessage] = Field(default_factory=list, max_length=20)
