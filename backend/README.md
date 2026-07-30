# TimeFlow Backend

## Requirements

- Python 3.11.15
- uv 0.11.28 or a compatible newer uv release

## Local setup

```bash
cp .env.example .env
uv sync --locked --all-groups
uv run uvicorn timeflow.main:app --reload
```

The API is available at `http://127.0.0.1:8000`. Health check:

```bash
curl http://127.0.0.1:8000/api/v1/health
```

## Verification

Run the complete backend quality gate:

```bash
bash scripts/check.sh
```

Or run each command separately:

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
uv run alembic heads
```

Smoke test for the structured LLM parser:

```bash
uv run python scripts/test_llm_extraction.py
```

## Module boundaries

- `api`: inbound HTTP routes, request/response models, and dependency wiring.
- `business`: domain types, use cases, Commands, Queries, and outbound Ports.
- `intelligence`: AI interpretation and candidate generation; it cannot persist business facts.
- `gateway`: adapters for external providers such as ASR, LLM, maps, or notifications.
- `data`: database models and repository implementations for business Ports.
- `infrastructure`: configuration, logging, and other cross-cutting runtime adapters.

Dependency direction is inward: outer layers may depend on `business`; `business` must not
import FastAPI, database libraries, provider SDKs, or another outer layer.
