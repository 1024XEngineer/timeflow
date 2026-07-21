"""主 Agent 请求上下文模型。"""

from pydantic import BaseModel, Field, field_validator

from timeapp.common.contracts.conversation import ConversationMessage


class AgentTarget(BaseModel):
    """意图识别后确定的单个 Agent 函数目标。"""

    agent_name: str
    function_name: str


class MainAgentRequest(BaseModel):
    """主 Agent 的原始输入和上下文。"""

    user_id: str
    raw_input: str
    conversation: list[ConversationMessage] = Field(default_factory=list)

    @field_validator("conversation")
    @classmethod
    def keep_recent_window(cls, messages: list[ConversationMessage]) -> list[ConversationMessage]:
        """MVP 阶段所有连续对话统一只保留最近 20 条。"""

        return messages[-20:]
