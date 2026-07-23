#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"

case "$TARGET" in
  all|backend|frontend) ;;
  *)
    echo "Usage: $0 [all|backend|frontend]" >&2
    exit 2
    ;;
esac

database_reachable() {
  uv run python -c '
from sqlalchemy import create_engine, text
from timeapp.core.config import get_settings

engine = create_engine(get_settings().database_url, pool_pre_ping=True)
with engine.connect() as connection:
    connection.execute(text("SELECT 1"))
'
}

if [[ "$TARGET" == "all" || "$TARGET" == "backend" ]]; then
  (
    cd "$ROOT/backend"
    uv sync --locked --all-groups
    uv run ruff check .
    uv run ruff format --check .
    uv run mypy
    uv run pytest
    uv run alembic history >/dev/null
    if database_reachable; then
      uv run alembic upgrade head
      uv run alembic check
    else
      echo "warning: PostgreSQL unreachable; skipped alembic upgrade/check (CI still runs them)" >&2
    fi
  )
fi

if [[ "$TARGET" == "all" || "$TARGET" == "frontend" ]]; then
  npm --prefix "$ROOT/frontend" ci
  npm --prefix "$ROOT/frontend" run check
  npm --prefix "$ROOT/frontend" audit --audit-level=moderate
fi
