#!/usr/bin/env bash
set -euo pipefail

alembic upgrade head
exec uvicorn timeapp.main:app --host 0.0.0.0 --port 8000 "$@"
