#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"
CHECK_DATABASE_URL="${TIMEAPP_CHECK_DATABASE_URL:-}"

case "$TARGET" in
  all|backend|frontend) ;;
  *)
    echo "Usage: $0 [all|backend|frontend]" >&2
    exit 2
    ;;
esac

run_database_checks() {
  if [[ -z "$CHECK_DATABASE_URL" ]]; then
    echo "warning: TIMEAPP_CHECK_DATABASE_URL is not set; skipped alembic upgrade/check" >&2
    return 0
  fi

  TIMEAPP_CHECK_DATABASE_URL="$CHECK_DATABASE_URL" uv run python -c '
import os

from sqlalchemy.engine import make_url

try:
    url = make_url(os.environ["TIMEAPP_CHECK_DATABASE_URL"])
except Exception:
    raise SystemExit("TIMEAPP_CHECK_DATABASE_URL must be a valid SQLAlchemy URL") from None

database = url.database or ""
if not url.drivername.startswith("postgresql"):
    raise SystemExit("TIMEAPP_CHECK_DATABASE_URL must use PostgreSQL")
if not database.endswith(("_test", "_check")):
    raise SystemExit("TIMEAPP_CHECK_DATABASE_URL database must end with _test or _check")
'

  TIMEAPP_DATABASE_URL="$CHECK_DATABASE_URL" uv run alembic upgrade head
  TIMEAPP_DATABASE_URL="$CHECK_DATABASE_URL" uv run alembic check
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
    run_database_checks
  )
fi

if [[ "$TARGET" == "all" || "$TARGET" == "frontend" ]]; then
  npm --prefix "$ROOT/frontend" ci
  npm --prefix "$ROOT/frontend" run check
  npm --prefix "$ROOT/frontend" audit --audit-level=moderate
fi
