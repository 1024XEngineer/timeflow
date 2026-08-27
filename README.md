<div align="center">

# TimeFlow

TimeFlow 是一款语音优先的个人日程助手，帮你用说话的方式管理时间、地点和提醒。

言出成约，时至如约。

**中文** | [English](README.en.md)

[![TimeFlow](https://img.shields.io/website?url=https%3A%2F%2Fappetize.io%2Fapp%2Fb_tk7kw3vv4rhigcusy2uxvxof4e%3Fdevice%3Dpixel7%26osVersion%3D13.0%26toolbar%3Dtrue&up_message=online&down_message=offline&label=TimeFlow)](https://appetize.io/app/b_tk7kw3vv4rhigcusy2uxvxof4e?device=pixel7&osVersion=13.0&toolbar=true)
[![Frontend CI](https://img.shields.io/github/check-runs/1024XEngineer/timeflow/main?nameFilter=Frontend%20(lint%2C%20types%2C%20build)&label=Frontend%20CI&logo=github)](https://github.com/1024XEngineer/timeflow/actions/workflows/ci.yml)
[![Backend CI](https://img.shields.io/github/check-runs/1024XEngineer/timeflow/main?nameFilter=Backend%20(lint%2C%20types%2C%20tests)&label=Backend%20CI&logo=github)](https://github.com/1024XEngineer/timeflow/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/1024XEngineer/timeflow?logo=codecov&label=codecov)](https://codecov.io/gh/1024XEngineer/timeflow)

</div>

## 目录

- [当前能力](#当前能力)
- [它如何工作](#它如何工作)
- [技术栈](#技术栈)
- [仓库结构](#仓库结构)
- [环境要求](#环境要求)
- [快速上手](#快速上手)
- [客户端如何连上本机 API](#客户端如何连上本机-api)
- [开启真实语音](#开启真实语音)
- [本机开发后端](#本机开发后端)
- [质量检查](#质量检查)
- [HTTP 与 WebSocket](#http-与-websocket)
- [环境变量](#环境变量)
- [云上部署与观测](#云上部署与观测)
- [CI 与 Android 预览](#ci-与-android-预览)
- [相关入口](#相关入口)

## 当前能力

- 登录或注册后查看日历（同一入口：用户名未注册则创建账号，已注册则校验密码）
- 时间日程与地点提醒
- 语音新建、查询、修改和删除安排
- 按住说话，或进入免提连续对话
- 到点提醒；到达指定地点时也会提醒
- 云端写入安排后，本地 SQLite 同步备份，日历立刻可见

客户端目前面向 **Android**。闹钟、后台定位和麦克风等能力依赖原生模块，需要开发构建（`expo run:android`），不能只用 Expo Go。

## 它如何工作

```text
说话
  → 助手理解意图
  → 调用日程工具
  → 云端写入安排
  → 本地同步备份
  → 助手语音回复
  → 日历立刻可见
  → 按照要求提醒
```

开发环境若未配置通义实时语音密钥，`/ws` 会使用占位助手（固定回复一条示例日程），账号、日历和同步仍然可用。非 development 环境必须配置真实语音，否则服务不会启动 WebSocket 助手。

## 技术栈

- 客户端：Expo 57、React Native、TypeScript、SQLite
- 服务端：Python 3.11、FastAPI、PostgreSQL 16
- 语音与地点：通义实时语音、腾讯地图检索（可选）

## 仓库结构

```text
TimeFlow/
├── frontend/                 # Expo / React Native Android 客户端
│   ├── src/features/         # 认证、日历、语音助手、提醒、同步
│   ├── src/infrastructure/   # HTTP、WebSocket、SQLite、定位、通知
│   └── modules/timeflow-alarm
├── backend/                  # FastAPI：账号、日程、语音助手、地点检索
│   ├── src/timeflow/
│   │   ├── business/         # 领域与用例
│   │   ├── data/             # 仓储与数据库
│   │   ├── gateway/          # HTTP / WebSocket 入站适配
│   │   ├── intelligence/     # 语音对话编排
│   │   └── infrastructure/   # 配置、JWT、外部供应商
│   └── alembic/              # 数据库迁移
├── docker-compose.yml        # PostgreSQL + API（可 build 或拉 GHCR 镜像）
├── docker-compose.observability.yml  # Grafana / Prometheus / Tempo
├── observability/            # 观测配置与云上部署说明
├── .env.example              # Compose 用的仓库根环境变量
├── README.md
└── README.en.md
```

## 环境要求

| 用途 | 版本 |
| --- | --- |
| Docker / Docker Compose | 能运行 Compose v2 |
| Node.js | `20.20.2`（`>=20.20.2 <21`） |
| npm | `10.8.2`（`>=10.8.2 <11`） |
| Android Studio | SDK、模拟器或已开启调试的真机 |
| JDK | 17（与 CI 一致） |
| 本机跑后端时 | Python **3.11.15**、[uv](https://docs.astral.sh/uv/) **0.11.28** 或兼容版本 |

JWT 密钥至少 **32 个 UTF-8 字节**。为空或过短时，真实 HTTP / WebSocket 认证组件会拒绝启动。

## 快速上手

下面这条路径会拉起 PostgreSQL 与 API，再在 Android 模拟器上安装客户端。

### 1. 克隆仓库

```bash
git clone https://github.com/1024XEngineer/timeflow.git
cd timeflow
```

### 2. 配置仓库根环境变量

```bash
cp .env.example .env
```

在 `.env` 里设置 `TIMEFLOW_JWT_SECRET`。不要提交该文件。生成示例：

```bash
openssl rand -base64 48
```

其余 Compose 默认值（数据库名 `timeapp`、API 端口 `8000`）可先保持不变。

### 3. 启动数据库与 API

```bash
docker compose up -d --build
```

Compose 会在启动 Uvicorn 前执行 `alembic upgrade head`。确认健康检查：

```bash
curl http://127.0.0.1:8000/api/v1/health
```

期望返回 `{"status":"ok"}`。这只表示进程存活，不包含数据库或语音/地图供应商是否已配置。

停止：

```bash
docker compose down
```

数据在 Docker volume `timeflow-postgres-data` 中。若要连库一起删掉：`docker compose down -v`。

### 4. 配置并启动 Android 客户端

```bash
cd frontend
cp .env.example .env
npm ci
```

`.env.example` 默认面向 **Android 模拟器**：`10.0.2.2` 会转到宿主机。因此模拟器里的 App 可以访问本机 `8000` 端口的 API。

先启动 Android 模拟器（或接上已开 USB 调试的真机，真机地址见下一节），然后：

```bash
npm run android
```

该命令会按 `app.config.js` 生成 `android/`（该目录默认不入库），编译开发构建并安装。之后日常改 JS/TS 可用：

```bash
npm start
```

### 5. 登录

打开 App 后用同一表单登录或注册：

- 用户名：3–64 个字符
- 密码：至少 8 个字符（服务端上限 128）

新用户名会创建账号；已存在的用户名会校验密码。

## 客户端如何连上本机 API

`frontend/.env` 决定 HTTP 与 WebSocket 地址。改完后需要重新启动 Metro / 重新编译，Expo 才会读到 `EXPO_PUBLIC_*`。

| 运行位置 | `EXPO_PUBLIC_API_URL` | `EXPO_PUBLIC_WS_URL` |
| --- | --- | --- |
| Android 模拟器 | `http://10.0.2.2:8000/api/v1` | `ws://10.0.2.2:8000/ws` |
| 同一局域网的 Android 真机 | `http://<电脑局域网IP>:8000/api/v1` | `ws://<电脑局域网IP>:8000/ws` |

真机还需要：电脑防火墙放行 `8000`，手机和电脑在同一网络，且后端监听 `0.0.0.0`（Compose 默认如此）。`EXPO_PUBLIC_DEVICE_ID` 可保持 `device_001`，用于 WebSocket 会话标识。

## 开启真实语音

Compose 默认只把数据库、JWT 和 CORS 注入 API 容器，**不会**带上阿里云密钥。因此 `docker compose up` 在 development 下走占位助手。

要让说话真正改日程，请用下一节在本机运行 API，并在 `backend/.env` 选择语音后端：

| `TIMEFLOW_VOICE_AGENT_MODE` | 说明 | 必填 |
| --- | --- | --- |
| `1`（默认） | 通义端到端实时模型（音频进、语音出） | `TIMEFLOW_ALIYUN_AUDIO_API_KEY`、`TIMEFLOW_ALIYUN_AUDIO_WORKSPACE_ID` |
| `2` | ASR → LLM 工具调用 → TTS 流水线 | `TIMEFLOW_ALIYUN_ASR_WS_URL` / `API_KEY`、`TIMEFLOW_OPENAI_BASE_URL` / `API_KEY`、`TIMEFLOW_ALIYUN_TTS_WS_URL` / `API_KEY` |

两种模式都可以选配：

| 变量 | 作用 |
| --- | --- |
| `TIMEFLOW_OPENAI_BASE_URL` / `TIMEFLOW_OPENAI_API_KEY` / `TIMEFLOW_OPENAI_MODEL` | 模式 1 下可选，用于日程分类；未配置时分类为空。模式 2 下 LLM 为必填 |
| `TIMEFLOW_TENCENT_MAP_KEY` | 可选；地点检索 |

完整列表和默认模型名见 [backend/.env.example](backend/.env.example)。密钥不要提交到 Git。

## 本机开发后端

适合改 Python 代码、开热重载，或挂上真实语音密钥。PostgreSQL 仍可用 Compose 只起数据库：

```bash
docker compose up -d db
```

然后：

```bash
cd backend
cp .env.example .env
```

至少设置 `TIMEFLOW_JWT_SECRET`（同样 ≥ 32 UTF-8 字节）。`TIMEFLOW_DATABASE_URL` 默认指向本机 `127.0.0.1:5432`，用户/密码/库名与 Compose 一致。

```bash
uv sync --locked --all-groups
uv run alembic upgrade head
uv run uvicorn timeflow.main:app --reload
```

API：`http://127.0.0.1:8000`。更细的模块边界、冒烟脚本见 [backend/README.md](backend/README.md)。

认证冒烟（不打印凭据或 Token）：

```bash
# 仓库根目录已用 Compose 拉起 API 时
cd backend
uv run python scripts/auth_integration_smoke.py
```

用真实前端认证适配器打同一 API：

```bash
cd frontend
EXPO_PUBLIC_API_URL=http://127.0.0.1:8000/api/v1 npm run test:auth:live
```

## 质量检查

后端（与 CI 同一套门禁）：

```bash
cd backend
bash scripts/check.sh
```

前端（lint、格式、类型、测试）：

```bash
cd frontend
npm run check
```

覆盖率：

```bash
cd frontend
npm run test:coverage
```

## HTTP 与 WebSocket

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/health` | 进程存活，响应为 `{"status":"ok"}` |
| `POST` | `/api/v1/auth/access` | 登录或注册，返回 JWT |
| `GET` | `/api/v1/schedule/snapshot` | 当前账号的日程快照（需 Bearer Token） |
| `PUT` | `/api/v1/schedule/reminder-state` | 确认提醒处置（需 Bearer Token） |
| `GET` | `/metrics` | Prometheus 指标 |
| WebSocket | `/ws` | 认证后的语音会话 |

## 环境变量

仓库里有三份模板，按运行方式选用：

| 文件 | 何时使用 |
| --- | --- |
| [`.env.example`](.env.example) | `docker compose`：数据库、API 端口、JWT、CORS、观测 |
| [`backend/.env.example`](backend/.env.example) | 本机 `uvicorn`：数据库 URL、JWT、语音、地图、追踪 |
| [`frontend/.env.example`](frontend/.env.example) | Android 客户端：API / WebSocket 地址、设备 ID |

仓库根 `.env` 里 Compose 会读取的项：

| 变量 | 说明 |
| --- | --- |
| `TIMEFLOW_JWT_SECRET` | 必填，至少 32 个 UTF-8 字节 |
| `POSTGRES_DB` / `USER` / `PASSWORD` / `PORT` | 默认 `timeapp` / `5432` |
| `POSTGRES_HOST` / `API_HOST` | 端口绑定地址，默认 `0.0.0.0`；云上建议 `127.0.0.1` |
| `API_PORT` | 默认 `8000` |
| `TIMEFLOW_ENVIRONMENT` | 默认 `development` |
| `TIMEFLOW_CORS_ALLOWED_ORIGINS` | 默认 `http://localhost:8081,http://127.0.0.1:8081`（Expo Metro） |
| `TIMEFLOW_API_IMAGE_TAG` | GHCR 镜像 tag，默认 `latest` |
| `GRAFANA_ADMIN_PASSWORD` | 启动观测 overlay 时必填 |
| `GRAFANA_ROOT_URL` | 浏览器访问 Grafana 的 URL；同域名 `/grafana/` 时末尾加 `/` |
| `GF_SERVER_SERVE_FROM_SUB_PATH` | 同域名子路径时设 `true` |
| `SENTRY_AUTH_TOKEN` | Grafana 读 sentry.io；不是 App 的 DSN |
| `TIMEFLOW_OTEL_EXPORTER_OTLP_ENDPOINT` | 空则不上报 trace；观测 overlay 默认 `http://tempo:4318` |

## 云上部署与观测

`main` 上的 CI 会把后端打成 `ghcr.io/1024xengineer/timeflow-backend:latest`。观测三件套是 Grafana / Prometheus / Tempo 官方镜像，配置在 [`observability/`](observability/README.md)。

云上可以只有 Compose + `.env` + `observability/`，用 GHCR 镜像跑 API，**不要** `--build`。同域名把 Grafana 挂在 `/grafana/` 的 Nginx 示例见 [`observability/nginx.example.conf`](observability/nginx.example.conf)。

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

国内拉 Docker Hub 失败、以及「目录里没有源码」时的步骤，见 [observability/README.md](observability/README.md)。

## CI 与 Android 预览

- 推送到 `main` 或打开非 draft PR 会跑 [ci.yml](.github/workflows/ci.yml)：后端 lint/类型/测试、迁移、前端检查与 Android export。合进 `main` 后还会把后端镜像推到 GHCR。
- 需要在浏览器里点这次提交的 APK 时，在 PR 评论 `/android-preview`（需仓库写权限），或在 Actions 里手动跑 **Android Preview**。日常 push 不会自动打 APK。

## 相关入口

- 在线预览：[Appetize](https://appetize.io/app/b_tk7kw3vv4rhigcusy2uxvxof4e?device=pixel7&osVersion=13.0&toolbar=true)
- 后端启动与检查：[backend/README.md](backend/README.md)
- 观测栈云上部署：[observability/README.md](observability/README.md)
- 需求与进度：[Issues](https://github.com/1024XEngineer/timeflow/issues)
- 英文说明：[README.en.md](README.en.md)
