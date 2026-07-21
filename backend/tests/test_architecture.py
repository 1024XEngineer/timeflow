"""Tests that enforce the MVP Agent ownership boundaries."""

import ast
from pathlib import Path

AGENTS_DIR = Path(__file__).parents[1] / "src" / "timeapp" / "agents"
SUB_AGENT_NAMES = {
    "feedback_agent",
    "replanning_agent",
    "review_agent",
    "schedule_todo_agent",
    "task_breakdown_agent",
}
FORBIDDEN_IMPORT_PREFIXES = (
    "sqlalchemy",
    "timeapp.api.dependencies",
    "timeapp.common.data",
    "timeapp.core.db",
)


def imported_modules(path: Path) -> set[str]:
    """返回 Python 文件中的绝对导入模块名。"""

    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


def test_sub_agents_are_internal_capability_packages() -> None:
    """专项 Agent 必须使用内部接口，不能暴露 HTTP Router。"""

    for agent_name in SUB_AGENT_NAMES:
        agent_dir = AGENTS_DIR / agent_name
        assert not (agent_dir / "router.py").exists()
        assert {"schemas.py", "service.py", "prompts.py"} <= {
            path.name for path in agent_dir.iterdir()
        }


def test_sub_agents_do_not_import_data_access() -> None:
    """专项 Agent 不得直接导入公共数据模块或数据库基础设施。"""

    for agent_name in SUB_AGENT_NAMES:
        for path in (AGENTS_DIR / agent_name).glob("*.py"):
            for module in imported_modules(path):
                assert not module.startswith(FORBIDDEN_IMPORT_PREFIXES)
