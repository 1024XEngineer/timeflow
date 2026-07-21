FROM python:3.11.15-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

RUN pip install --no-cache-dir uv==0.11.28

COPY pyproject.toml uv.lock README.md alembic.ini docker-entrypoint.sh ./
COPY src ./src
COPY alembic ./alembic
RUN uv sync --frozen --no-dev \
  && chmod +x /app/docker-entrypoint.sh

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health')"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
