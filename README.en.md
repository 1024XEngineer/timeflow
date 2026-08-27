<div align="center">

# TimeFlow

TimeFlow is a voice-first personal schedule assistant. Speak to manage time, places, and reminders.

Say it, and it is scheduled. When the time comes, it keeps the promise.

[中文](README.md) | **English**

[![TimeFlow](https://img.shields.io/website?url=https%3A%2F%2Fappetize.io%2Fapp%2Fb_tk7kw3vv4rhigcusy2uxvxof4e%3Fdevice%3Dpixel7%26osVersion%3D13.0%26toolbar%3Dtrue&up_message=online&down_message=offline&label=TimeFlow)](https://appetize.io/app/b_tk7kw3vv4rhigcusy2uxvxof4e?device=pixel7&osVersion=13.0&toolbar=true)
[![Frontend CI](https://img.shields.io/github/check-runs/1024XEngineer/timeflow/main?nameFilter=Frontend%20(lint%2C%20types%2C%20build)&label=Frontend%20CI&logo=github)](https://github.com/1024XEngineer/timeflow/actions/workflows/ci.yml)
[![Backend CI](https://img.shields.io/github/check-runs/1024XEngineer/timeflow/main?nameFilter=Backend%20(lint%2C%20types%2C%20tests)&label=Backend%20CI&logo=github)](https://github.com/1024XEngineer/timeflow/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/1024XEngineer/timeflow?logo=codecov&label=codecov)](https://codecov.io/gh/1024XEngineer/timeflow)

</div>

## Contents

- [What it can do](#what-it-can-do)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Pointing the app at a local API](#pointing-the-app-at-a-local-api)
- [Enabling real voice](#enabling-real-voice)
- [Running the API on the host](#running-the-api-on-the-host)
- [Quality gates](#quality-gates)
- [HTTP and WebSocket](#http-and-websocket)
- [Environment variables](#environment-variables)
- [Cloud deploy and observability](#cloud-deploy-and-observability)
- [CI and Android preview](#ci-and-android-preview)
- [Related links](#related-links)

## What it can do

- Sign in or register, then open the calendar (one form: a new username creates an account; an existing username checks the password)
- Time-based events and place-based reminders
- Create, query, update, and delete schedules by voice
- Press-and-hold talk, or a hands-free continuous conversation
- Reminders at the scheduled time, and when you arrive at a place
- Cloud writes are mirrored to local SQLite so the calendar updates immediately

The client targets **Android**. Alarms, background location, and the microphone depend on native modules, so you need a development build (`expo run:android`). Expo Go is not enough.

## How it works

```text
Speech
  → the assistant understands intent
  → it calls schedule tools
  → the cloud stores the event
  → the device keeps a local copy
  → the assistant replies by voice
  → the calendar updates
  → reminders fire as requested
```

If Tongyi realtime credentials are missing in development, `/ws` uses a stand-in agent that always returns a sample event. Accounts, calendar, and sync still work. Outside development, real voice must be configured or the server will not start the WebSocket assistant.

## Tech stack

- Client: Expo 57, React Native, TypeScript, SQLite
- Server: Python 3.11, FastAPI, PostgreSQL 16
- Voice and places: Tongyi realtime speech, Tencent Maps search (optional)

## Repository layout

```text
TimeFlow/
├── frontend/                 # Expo / React Native Android client
│   ├── src/features/         # auth, calendar, voice assistant, reminders, sync
│   ├── src/infrastructure/   # HTTP, WebSocket, SQLite, location, notifications
│   └── modules/timeflow-alarm
├── backend/                  # FastAPI: accounts, schedules, voice, place search
│   ├── src/timeflow/
│   │   ├── business/         # domain and use cases
│   │   ├── data/             # repositories and database
│   │   ├── gateway/          # inbound HTTP / WebSocket adapters
│   │   ├── intelligence/     # conversation orchestration
│   │   └── infrastructure/   # settings, JWT, vendor adapters
│   └── alembic/              # database migrations
├── docker-compose.yml        # PostgreSQL + API (build locally or pull GHCR)
├── docker-compose.observability.yml  # Grafana / Prometheus / Tempo
├── observability/            # scrape/trace configs and cloud deploy notes
├── .env.example              # root env vars for Compose
├── README.md
└── README.en.md
```

## Requirements

| Purpose | Version |
| --- | --- |
| Docker / Docker Compose | Compose v2 |
| Node.js | `20.20.2` (`>=20.20.2 <21`) |
| npm | `10.8.2` (`>=10.8.2 <11`) |
| Android Studio | SDK, emulator, or a device with USB debugging |
| JDK | 17 (same as CI) |
| Host-run API | Python **3.11.15**, [uv](https://docs.astral.sh/uv/) **0.11.28** or compatible |

The JWT secret must be at least **32 UTF-8 bytes**. The real HTTP and WebSocket auth components refuse to start with an empty or weak secret.

## Getting started

This path starts PostgreSQL and the API, then installs the client on an Android emulator.

### 1. Clone

```bash
git clone https://github.com/1024XEngineer/timeflow.git
cd timeflow
```

### 2. Configure root environment variables

```bash
cp .env.example .env
```

Set `TIMEFLOW_JWT_SECRET` in `.env`. Do not commit that file. Example:

```bash
openssl rand -base64 48
```

Compose defaults (database `timeapp`, API port `8000`) can stay as they are for a first run.

### 3. Start the database and API

```bash
docker compose up -d --build
```

Compose runs `alembic upgrade head` before Uvicorn. Check health:

```bash
curl http://127.0.0.1:8000/api/v1/health
```

Expect `{"status":"ok"}`. That is process liveness only; it does not report whether the database or voice/maps providers are configured.

Stop:

```bash
docker compose down
```

Data lives in the Docker volume `timeflow-postgres-data`. To drop it as well: `docker compose down -v`.

### 4. Configure and start the Android client

```bash
cd frontend
cp .env.example .env
npm ci
```

`.env.example` targets an **Android emulator**: `10.0.2.2` is the host machine, so the app can reach the API on host port `8000`.

Start an emulator (or plug in a device with USB debugging; see the next section for device URLs), then:

```bash
npm run android
```

This generates `android/` from `app.config.js` (that folder is gitignored), builds a development binary, and installs it. After the native project exists, day-to-day JS/TS work can use:

```bash
npm start
```

### 5. Sign in

Use the same form to register or sign in:

- Username: 3–64 characters
- Password: at least 8 characters (server maximum 128)

A new username creates an account. An existing username verifies the password.

## Pointing the app at a local API

`frontend/.env` sets HTTP and WebSocket URLs. Restart Metro or rebuild after changes so Expo picks up `EXPO_PUBLIC_*`.

| Where the app runs | `EXPO_PUBLIC_API_URL` | `EXPO_PUBLIC_WS_URL` |
| --- | --- | --- |
| Android emulator | `http://10.0.2.2:8000/api/v1` | `ws://10.0.2.2:8000/ws` |
| Android device on the same LAN | `http://<host-lan-ip>:8000/api/v1` | `ws://<host-lan-ip>:8000/ws` |

On a physical device, allow port `8000` through the host firewall, keep phone and computer on the same network, and make sure the API listens on `0.0.0.0` (Compose does). `EXPO_PUBLIC_DEVICE_ID` can stay `device_001`; it identifies the WebSocket session.

## Enabling real voice

Compose injects database, JWT, and CORS into the API container. It does **not** pass Aliyun keys, so `docker compose up` uses the stand-in agent in development.

For speech that actually writes schedules, run the API on the host (next section) and pick a voice backend in `backend/.env`:

| `TIMEFLOW_VOICE_AGENT_MODE` | What it is | Required |
| --- | --- | --- |
| `1` (default) | Tongyi end-to-end realtime (audio in, speech out) | `TIMEFLOW_ALIYUN_AUDIO_API_KEY`, `TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID` |
| `2` | ASR → LLM tool calls → TTS pipeline | `TIMEFLOW_ALIYUN_ASR_WS_URL` / `API_KEY`, `TIMEFLOW_OPENAI_BASE_URL` / `API_KEY`, `TIMEFLOW_ALIYUN_TTS_WS_URL` / `API_KEY` |

Optional for both modes:

| Variable | Role |
| --- | --- |
| `TIMEFLOW_OPENAI_BASE_URL` / `TIMEFLOW_OPENAI_API_KEY` / `TIMEFLOW_OPENAI_MODEL` | Optional schedule category in mode 1 (left empty if unset). Required LLM in mode 2 |
| `TIMEFLOW_TENCENT_MAP_KEY` | Optional place search |

See [backend/.env.example](backend/.env.example) for the full list and default model names. Never commit secrets.

## Running the API on the host

Use this when you change Python, want reload, or need real voice keys. PostgreSQL can still come from Compose:

```bash
docker compose up -d db
```

Then:

```bash
cd backend
cp .env.example .env
```

Set `TIMEFLOW_JWT_SECRET` (≥ 32 UTF-8 bytes). `TIMEFLOW_DATABASE_URL` defaults to `127.0.0.1:5432` with the same user, password, and database as Compose.

```bash
uv sync --locked --all-groups
uv run alembic upgrade head
uv run uvicorn timeflow.main:app --reload
```

The API is at `http://127.0.0.1:8000`. Module boundaries and smoke scripts: [backend/README.md](backend/README.md).

Auth smoke (never prints credentials or tokens):

```bash
# from backend, with the API already up via Compose
uv run python scripts/auth_integration_smoke.py
```

Exercise the real frontend auth adapter against the same API:

```bash
cd frontend
EXPO_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1 npm run test:auth:live
```

## Quality gates

Backend (same gate as CI):

```bash
cd backend
bash scripts/check.sh
```

Frontend (lint, format, types, tests):

```bash
cd frontend
npm run check
```

Coverage:

```bash
cd frontend
npm run test:coverage
```

## HTTP and WebSocket

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Process liveness; body is `{"status":"ok"}` |
| `POST` | `/api/v1/auth/access` | Sign in or register; returns a JWT |
| `GET` | `/api/v1/schedule/snapshot` | Schedule snapshot for the token’s account |
| `PUT` | `/api/v1/schedule/reminder-state` | Confirm reminder disposition |
| `GET` | `/metrics` | Prometheus metrics |
| WebSocket | `/ws` | Authenticated voice session |

## Environment variables

There are three templates, depending on how you run things:

| File | When |
| --- | --- |
| [`.env.example`](.env.example) | `docker compose`: database, API, JWT, CORS, observability |
| [`backend/.env.example`](backend/.env.example) | Host `uvicorn`: database URL, JWT, voice, maps, tracing |
| [`frontend/.env.example`](frontend/.env.example) | Android client: API / WebSocket URLs, device ID |

Compose interpolates the root `.env` for `${VAR}` substitution. The API container only receives the backend allowlist in `docker-compose.yml`; `GRAFANA_*` and `SENTRY_AUTH_TOKEN` go to Grafana only.

| Variable | Notes |
| --- | --- |
| `TIMEFLOW_JWT_SECRET` | Required, at least 32 UTF-8 bytes |
| `POSTGRES_DB` / `USER` / `PASSWORD` / `PORT` | Defaults `timeapp` / `5432` |
| `POSTGRES_HOST` / `API_HOST` | Bind address, default `0.0.0.0`; use `127.0.0.1` on a public VM |
| `API_PORT` | Default `8000` |
| `TIMEFLOW_ENVIRONMENT` | Default `development` |
| `TIMEFLOW_CORS_ALLOWED_ORIGINS` | Default `http://localhost:8081,http://127.0.0.1:8081` (Expo Metro) |
| `TIMEFLOW_API_IMAGE_TAG` | GHCR image tag, default `latest` |
| `GRAFANA_ADMIN_PASSWORD` | Required when the observability overlay is used |
| `GRAFANA_ROOT_URL` | Public Grafana URL; include a trailing `/` for a `/grafana/` subpath |
| `GF_SERVER_SERVE_FROM_SUB_PATH` | `true` when Grafana shares the API host under `/grafana/` |
| `SENTRY_AUTH_TOKEN` | Grafana → sentry.io; not the app DSN |
| `TIMEFLOW_OTEL_EXPORTER_OTLP_ENDPOINT` | Empty disables traces; the overlay defaults to `http://tempo:4318` |

## Cloud deploy and observability

CI on `main` publishes `ghcr.io/1024xengineer/timeflow-backend:latest`. Grafana, Prometheus, and Tempo stay official images; their config lives under [`observability/`](observability/README.md).

A cloud host can run from Compose + `.env` + `observability/` and the GHCR API image. Do not pass `--build`. Nginx for Grafana on the same hostname at `/grafana/` is in [`observability/nginx.example.conf`](observability/nginx.example.conf).

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

If Docker Hub is unreachable, or the server has no source tree, follow [observability/README.md](observability/README.md).

## CI and Android preview

- Pushes to `main` and non-draft PRs run [ci.yml](.github/workflows/ci.yml): backend lint/types/tests, migrations, frontend checks, and an Android export. Merges to `main` also push the backend image to GHCR.
- For a browser-clickable APK of a PR, comment `/android-preview` (write access required) or run **Android Preview** from Actions. Regular pushes do not build an APK.

## Related links

- Live preview: [Appetize](https://appetize.io/app/b_tk7kw3vv4rhigcusy2uxvxof4e?device=pixel7&osVersion=13.0&toolbar=true)
- Backend setup and checks: [backend/README.md](backend/README.md)
- Observability on a cloud host: [observability/README.md](observability/README.md)
- Work tracking: [Issues](https://github.com/1024XEngineer/timeflow/issues)
- Chinese README: [README.md](README.md)
