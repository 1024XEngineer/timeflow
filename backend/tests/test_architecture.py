"""Static dependency checks for the business layer."""

import ast
from pathlib import Path

FORBIDDEN_IMPORTS = {
    "fastapi",
    "sqlalchemy",
    "timeflow.api",
    "timeflow.data",
    "timeflow.gateway",
    "timeflow.infrastructure",
    "timeflow.intelligence",
}
BUSINESS_ROOT = Path(__file__).parents[1] / "src" / "timeflow" / "business"


def test_business_layer_has_no_outer_layer_imports() -> None:
    """The business layer must remain independent from frameworks and adapters."""
    violations: list[str] = []

    for path in BUSINESS_ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            imported_names: list[str] = []
            if isinstance(node, ast.Import):
                imported_names.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported_names.append(node.module)

            for imported_name in imported_names:
                if any(
                    imported_name == forbidden or imported_name.startswith(f"{forbidden}.")
                    for forbidden in FORBIDDEN_IMPORTS
                ):
                    violations.append(f"{path.name}:{node.lineno} imports {imported_name}")

    assert violations == []
