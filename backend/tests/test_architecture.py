"""Static dependency checks for every layer (architecture design appendix A)."""

import ast
from pathlib import Path

VENDOR_MODEL_SDKS = ("openai", "dashscope")
TRANSPORT_LIBRARIES = ("websockets", "httpx", "httpx2")

# Per-layer forbidden imports. A layer may never import the modules listed for it,
# which encodes the dependency direction: the composition root assembles the layers,
# the gateway depends on use cases and capability ports, business and intelligence
# depend on abstractions only, and adapters live in data and infrastructure.
FORBIDDEN_IMPORTS: dict[str, frozenset[str]] = {
    # A.1: no frameworks, no ORM, no serialization, no model SDKs, no outer layers.
    "business": frozenset(
        {
            "fastapi",
            "starlette",
            "sqlalchemy",
            "pydantic",
            *VENDOR_MODEL_SDKS,
            *TRANSPORT_LIBRARIES,
            "timeflow.data",
            "timeflow.gateway",
            "timeflow.infrastructure",
            "timeflow.intelligence",
        }
    ),
    # A.2: persistence only; no inbound protocol models, no model SDKs.
    "data": frozenset(
        {
            "fastapi",
            "starlette",
            *VENDOR_MODEL_SDKS,
            *TRANSPORT_LIBRARIES,
            "timeflow.gateway",
            "timeflow.intelligence",
        }
    ),
    # A.3: protocol only; must not reach the database, adapt vendor services, or depend
    # on the dialogue layer -- the agent seam is structural, declared in agent_ports.py.
    "gateway": frozenset(
        {
            "sqlalchemy",
            "openai",
            "dashscope",
            "timeflow.data",
            "timeflow.infrastructure.external",
            "timeflow.intelligence",
        }
    ),
    # A.4: runtime capability only; must not depend on product layers.
    "infrastructure": frozenset(
        {
            "timeflow.business",
            "timeflow.data",
            "timeflow.gateway",
            "timeflow.intelligence",
        }
    ),
    # A.5: orchestration through ports; no frameworks, no direct SDK or database access.
    "intelligence": frozenset(
        {
            "fastapi",
            "starlette",
            "sqlalchemy",
            "openai",
            "dashscope",
            "timeflow.data",
            "timeflow.gateway",
        }
    ),
}

PACKAGE_ROOT = Path(__file__).parents[1] / "src" / "timeflow"


def _imported_modules(tree: ast.AST) -> list[tuple[int, str]]:
    """Collect (line number, module) for every import in a parsed module."""
    imports: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend((node.lineno, alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imports.append((node.lineno, node.module))
    return imports


def _violations(layer: str, forbidden: frozenset[str]) -> list[str]:
    """List forbidden imports found anywhere under a layer."""
    found: list[str] = []
    for path in sorted((PACKAGE_ROOT / layer).rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for lineno, module in _imported_modules(tree):
            if any(module == name or module.startswith(f"{name}.") for name in forbidden):
                found.append(f"{layer}/{path.relative_to(PACKAGE_ROOT / layer)}:{lineno} {module}")
    return found


def test_every_layer_respects_its_forbidden_imports() -> None:
    """No layer imports the modules its architecture entry forbids."""
    violations = [
        violation
        for layer, forbidden in FORBIDDEN_IMPORTS.items()
        for violation in _violations(layer, forbidden)
    ]

    assert violations == []


def test_all_declared_layers_exist() -> None:
    """Every layer named in the forbidden-import table is a real package."""
    missing = [layer for layer in FORBIDDEN_IMPORTS if not (PACKAGE_ROOT / layer).is_dir()]

    assert missing == []


def test_gateway_does_not_import_vendor_adapters() -> None:
    """The gateway reaches external providers only through injected ports."""
    violations = _violations("gateway", frozenset({"timeflow.infrastructure"}))

    assert violations == []
