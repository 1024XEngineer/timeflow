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

## Module boundaries

- `business`: domain types, use cases, Commands, Queries, and outbound Ports.
- `data`: database models and repository implementations for business Ports.
- `gateway`: inbound HTTP and WebSocket adapters that translate client protocols into internal calls.
- `infrastructure`: configuration, logging, runtime services, and external-provider adapters.
- `intelligence`: AI conversation orchestration and provider-neutral ASR, LLM, and TTS ports; it cannot persist business facts.

External-provider adapters such as ASR, LLM, maps, or notifications live under
`infrastructure/external/` and implement ports defined by the inner business or intelligence
layers. Dependency direction is inward: business and intelligence must not import FastAPI,
database libraries, provider SDKs, gateway modules, or infrastructure implementations.
