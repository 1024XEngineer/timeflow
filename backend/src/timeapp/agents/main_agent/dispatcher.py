"""主 Agent 调用单个子 Agent 函数的内部路由器。"""

from collections.abc import Awaitable, Callable
from typing import Any, TypeAlias

from timeapp.agents.main_agent.schemas import AgentTarget
from timeapp.common.contracts.agent_response import AgentResponse

AgentHandler: TypeAlias = Callable[[dict[str, Any]], Awaitable[AgentResponse]]


class UnknownAgentFunctionError(LookupError):
    """目标 Agent 或函数没有注册。"""


class AgentDispatcher:
    """按 agent_name 和 function_name 调用一个内部 Agent 函数。"""

    def __init__(self) -> None:
        self._handlers: dict[tuple[str, str], AgentHandler] = {}

    def register(self, target: AgentTarget, handler: AgentHandler) -> None:
        """注册一个可由主 Agent 调用的内部函数。"""

        self._handlers[(target.agent_name, target.function_name)] = handler

    async def dispatch(self, target: AgentTarget, payload: dict[str, Any]) -> AgentResponse:
        """调用唯一目标函数；未知目标交由主 Agent 统一处理。"""

        handler = self._handlers.get((target.agent_name, target.function_name))
        if handler is None:
            raise UnknownAgentFunctionError(
                f"unknown agent function: {target.agent_name}.{target.function_name}"
            )
        return await handler(payload)
