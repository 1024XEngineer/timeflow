# TimeFlow

## Clone and start

```bash
git clone https://github.com/Alexander-Noah/timeflow.git
cd timeflow
cp .env.example .env
docker compose up --build
```

The backend health endpoint is available at:

```text
http://127.0.0.1:8000/api/v1/health
```

For local backend development without Docker, follow
[`backend/README.md`](backend/README.md).
