"""Static dependency checks enforcing the direction between layers."""

import ast
from dataclasses import FrozenInstanceError, fields, is_dataclass
from pathlib import Path
from typing import Any, get_args

from timeflow.intelligence.conversation import asr, llm

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
            *TRANSPORT_LIBRARIES,
            "timeflow.data",
            "timeflow.gateway",
            "timeflow.infrastructure",
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


def test_only_external_infrastructure_imports_intelligence_ports() -> None:
    """Only external provider adapters may implement intelligence-owned ports."""
    violations: list[str] = []
    infrastructure_root = PACKAGE_ROOT / "infrastructure"
    for path in sorted(infrastructure_root.rglob("*.py")):
        relative_path = path.relative_to(infrastructure_root)
        if relative_path.parts[0] == "external":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for lineno, module in _imported_modules(tree):
            if module == "timeflow.intelligence" or module.startswith("timeflow.intelligence."):
                violations.append(f"infrastructure/{relative_path}:{lineno} {module}")

    assert violations == []


def test_asr_public_contract_is_provider_neutral() -> None:
    """The ASR port exposes only provider-neutral events, errors, and stream API."""
    for event_type in (asr.TranscriptPreview, asr.TranscriptCompleted):
        assert is_dataclass(event_type)
        dataclass_type: Any = event_type
        assert dataclass_type.__slots__ == ("text",)
        assert [field.name for field in fields(dataclass_type)] == ["text"]
        instance: Any = dataclass_type("hello")
        assert instance.text == "hello"
        try:
            instance.text = "changed"
        except FrozenInstanceError:
            pass
        else:  # pragma: no cover - assertion branch only runs on regression
            raise AssertionError(f"{dataclass_type.__name__} must be frozen")

    assert set(get_args(asr.AsrEvent)) == {asr.TranscriptPreview, asr.TranscriptCompleted}
    assert asr.AsrPort.stream.__annotations__ == {
        "audio_chunks": "AsyncIterable[bytes]",
        "return": "AsyncIterator[AsrEvent]",
    }

    assert issubclass(asr.AsrConnectionError, asr.AsrError)
    assert issubclass(asr.AsrProtocolError, asr.AsrError)
    assert issubclass(asr.AsrTranscriptionError, asr.AsrError)

    asr_path = PACKAGE_ROOT / "intelligence" / "conversation" / "asr.py"
    source = asr_path.read_text(encoding="utf-8")
    provider_specific_terms = {
        "item_id",
        "content_index",
        "stash",
        "emotion",
        "qwen",
        "base64",
        "websocket",
    }
    assert not any(term in source.lower() for term in provider_specific_terms)


def test_llm_public_contract_is_provider_neutral() -> None:
    """The LLM port exposes immutable provider-neutral messages and events."""
    event_types = (llm.TextDelta, llm.ToolCallDelta, llm.LlmUsage, llm.LlmStreamCompleted)
    for event_type in event_types:
        assert is_dataclass(event_type)
        dataclass_type: Any = event_type
        assert dataclass_type.__dataclass_params__.frozen is True

    assert set(get_args(llm.LlmEvent)) == {
        llm.TextDelta,
        llm.ToolCallDelta,
        llm.LlmStreamCompleted,
    }
    assert llm.LlmPort.stream.__annotations__ == {
        "messages": "Sequence[LlmMessage]",
        "tools": "Sequence[ToolDefinition]",
        "return": "AsyncIterator[LlmEvent]",
    }
    assert issubclass(llm.LlmProviderError, llm.LlmError)
    assert issubclass(llm.LlmProtocolError, llm.LlmError)

    llm_path = PACKAGE_ROOT / "intelligence" / "conversation" / "llm.py"
    source = llm_path.read_text(encoding="utf-8").lower()
    provider_specific_terms = {
        "openai",
        "qwen",
        "dashscope",
        "base_url",
        "extra_body",
        "asyncopenai",
    }
    assert not any(term in source for term in provider_specific_terms)
