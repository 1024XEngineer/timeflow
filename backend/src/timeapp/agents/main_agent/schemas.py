"""主 Agent 数据模型占位。"""

from pydantic import BaseModel


class AgentTarget(BaseModel):
    """等待 Agent 路由协议确定后补充字段。"""


class MainAgentRequest(BaseModel):
    """等待主 Agent 请求协议确定后补充字段。"""
