"""Tests for the MVP Agent boundary contracts."""

import asyncio

import pytest
from pydantic import ValidationError

from timeapp.agents.main_agent.dispatcher import AgentDispatcher, UnknownAgentFunctionError
from timeapp.agents.main_agent.schemas import AgentTarget, MainAgentRequest
from timeapp.common.contracts.agent_response import AgentResponse
from timeapp.common.contracts.conversation import ConversationMessage


def test_agent_response_requires_confirmation_for_database_action() -> None:
    """数据库动作只能出现在需要用户确认的响应中。"""

    response = AgentResponse(
        agent_name="schedule_todo_agent",
        function_name="create_item",
        is_need_user=True,
        is_display_result=False,
        is_error=False,
        result={"title": "完成周报"},
        db_action={"action": "create"},
    )

    assert response.db_action == {"action": "create"}

    with pytest.raises(ValidationError):
        AgentResponse(
            agent_name="schedule_todo_agent",
            function_name="create_item",
            is_need_user=False,
            is_display_result=True,
            is_error=False,
            result={},
            db_action={"action": "create"},
        )


def test_main_agent_keeps_recent_twenty_messages() -> None:
    """主 Agent 请求统一截取最近 20 条对话。"""

    messages = [ConversationMessage(role="user", content=str(index)) for index in range(25)]
    request = MainAgentRequest(user_id="user_1", raw_input="继续", conversation=messages)

    assert len(request.conversation) == 20
    assert request.conversation[0].content == "5"


def test_dispatcher_calls_one_registered_agent_function() -> None:
    """主 Agent 每次只分发到一个明确的 Agent 函数。"""

    dispatcher = AgentDispatcher()
    target = AgentTarget(agent_name="review_agent", function_name="generate_review")

    async def handler(payload: dict[str, object]) -> AgentResponse:
        return AgentResponse(
            agent_name="review_agent",
            function_name="generate_review",
            is_need_user=False,
            is_display_result=True,
            is_error=False,
            result=payload,
        )

    dispatcher.register(target, handler)
    response = asyncio.run(dispatcher.dispatch(target, {"review_type": "all_items"}))

    assert response.agent_name == "review_agent"

    unknown = AgentTarget(agent_name="unknown", function_name="unknown")
    with pytest.raises(UnknownAgentFunctionError):
        asyncio.run(dispatcher.dispatch(unknown, {}))
