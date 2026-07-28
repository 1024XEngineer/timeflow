FROM ghcr.io/astral-sh/uv:0.11.28 AS uv

FROM python:3.11.15-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

COPY --from=uv /uv /uvx /bin/
COPY pyproject.toml uv.lock README.md .python-version ./
RUN uv sync --locked --no-dev --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY src ./src
RUN uv sync --locked --no-dev

EXPOSE 8000

CMD [".venv/bin/uvicorn", "timeflow.main:app", "--host", "0.0.0.0", "--port", "8000"]
