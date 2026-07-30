"""Static dependency checks for layer boundaries."""

import ast
from pathlib import Path

SRC_ROOT = Path(__file__).parents[1] / "src" / "timeflow"

BUSINESS_FORBIDDEN_IMPORTS = {
    "fastapi",
    "sqlalchemy",
    "timeflow.api",
    "timeflow.data",
    "timeflow.gateway",
    "timeflow.infrastructure",
    "timeflow.intelligence",
}

WEBSOCKET_FORBIDDEN_IMPORTS = {
    "sqlalchemy",
    "timeflow.api",
    "timeflow.data",
    "timeflow.gateway",
    "timeflow.intelligence",
}

WORKERS_FORBIDDEN_IMPORTS = {
    "sqlalchemy",
    "timeflow.api",
    "timeflow.data",
    "timeflow.gateway",
    "timeflow.intelligence",
}


def _find_forbidden_imports(root: Path, forbidden: set[str]) -> list[str]:
    """Return `path:line imports name` for every import outside the allowed set."""
    violations: list[str] = []

    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            imported_names: list[str] = []
            if isinstance(node, ast.Import):
                imported_names.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported_names.append(node.module)

            for imported_name in imported_names:
                if any(
                    imported_name == name or imported_name.startswith(f"{name}.")
                    for name in forbidden
                ):
                    violations.append(f"{path.name}:{node.lineno} imports {imported_name}")

    return violations


def test_business_layer_has_no_outer_layer_imports() -> None:
    """The business layer must remain independent from frameworks and adapters."""
    violations = _find_forbidden_imports(SRC_ROOT / "business", BUSINESS_FORBIDDEN_IMPORTS)

    assert violations == []


def test_websocket_layer_does_not_depend_on_data_gateway_or_intelligence() -> None:
    """`infrastructure/websocket` may only reach `business`, FastAPI, and Pydantic."""
    violations = _find_forbidden_imports(
        SRC_ROOT / "infrastructure" / "websocket", WEBSOCKET_FORBIDDEN_IMPORTS
    )

    assert violations == []


def test_workers_layer_does_not_depend_on_data_gateway_or_intelligence() -> None:
    """`infrastructure/workers` may only reach `business` and sibling `infrastructure` code."""
    violations = _find_forbidden_imports(
        SRC_ROOT / "infrastructure" / "workers", WORKERS_FORBIDDEN_IMPORTS
    )

    assert violations == []
