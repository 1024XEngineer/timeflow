"""Tests for the Agent package placeholders."""

from timeapp.agents.main_agent.dispatcher import AgentDispatcher
from timeapp.agents.main_agent.schemas import AgentTarget, MainAgentRequest
from timeapp.common.contracts.agent_response import AgentResponse
from timeapp.common.contracts.conversation import ConversationMessage


def test_agent_placeholders_are_importable() -> None:
    """保留目录和模型名称，不预设调用协议或业务规则。"""

    assert {AgentDispatcher, AgentTarget, MainAgentRequest, AgentResponse, ConversationMessage}
