"""MVP 阶段所有子 Agent 的统一响应结构。"""

from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AgentResponse(BaseModel):
    """子 Agent 返回给主 Agent 的统一结构。"""

    model_config = ConfigDict(populate_by_name=True)

    agent_name: str
    function_name: str
    is_need_user: bool = Field(alias="isNeedUser")
    is_display_result: bool = Field(alias="isDisplayResult")
    is_error: bool = Field(alias="isError")
    result: Any
    db_action: dict[str, Any] | None = None
    error_message: str | None = None

    @model_validator(mode="after")
    def validate_control_flags(self) -> Self:
        """禁止错误响应或未确认响应携带可执行数据库动作。"""

        if self.is_error and self.db_action is not None:
            raise ValueError("error response cannot contain db_action")
        if self.db_action is not None and not self.is_need_user:
            raise ValueError("db_action requires isNeedUser=true")
        return self
