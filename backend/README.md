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

Before starting the application, set `TIMEFLOW_JWT_SECRET` in `.env` to a private random
value of at least 32 UTF-8 bytes. The real HTTP and WebSocket authentication components
intentionally refuse to start with an empty or weak secret.

The API is available at `http://127.0.0.1:8000`. Health check:

```bash
curl http://127.0.0.1:8000/api/v1/health
```

## Authentication integration smoke

Start PostgreSQL and the API from the repository root. Compose applies migrations before
starting Uvicorn and requires a JWT secret with at least 32 UTF-8 bytes:

```bash
TIMEFLOW_JWT_SECRET=replace-with-a-private-random-value docker compose up -d --build
```

Then verify the health endpoint, Expo Web CORS preflight, new and existing account access,
and the authenticated WebSocket handshake. The command never prints credentials or tokens:

```bash
uv run python scripts/auth_integration_smoke.py
```

To exercise the real frontend authentication adapter and controller against the same API:

```bash
cd ../frontend
EXPO_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1 npm run test:auth:live
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
