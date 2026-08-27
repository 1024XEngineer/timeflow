# 观测栈部署

Prometheus 刮 API 的 `GET /metrics`，Tempo 收 OTLP，Grafana 画看板。客户端提醒看板走 Sentry 插件，需要 `SENTRY_AUTH_TOKEN`（不是 App 的 DSN）。

推到 `main` 后，CI 会把后端镜像推到 `ghcr.io/1024xengineer/timeflow-backend:latest`。Grafana / Prometheus / Tempo 用官方镜像，不打进这个包。

## 云上（已有 API 容器、没有源码目录）

部署目录只需：

```text
/opt/timeflow/
  docker-compose.yml
  docker-compose.observability.yml
  .env
  observability/
```

从仓库拷这两份 Compose、`.env.example` → `.env`，以及整个 `observability/`。不要拷 `backend/`、`frontend/`。

`.env` 里观测相关至少：

```bash
GRAFANA_ADMIN_PASSWORD=强密码
GRAFANA_HOST=127.0.0.1
GRAFANA_PORT=3000
GRAFANA_ROOT_URL=http://127.0.0.1:3000
GF_SERVER_SERVE_FROM_SUB_PATH=false
TIMEFLOW_OTEL_SERVICE_NAME=timeflow-backend
TIMEFLOW_OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
TIMEFLOW_API_IMAGE_TAG=latest
```

与 API 同域名、路径 `/grafana/` 时：

```bash
GRAFANA_ROOT_URL=https://api.example.com/grafana/
GF_SERVER_SERVE_FROM_SUB_PATH=true
```

`GRAFANA_ROOT_URL` 必须是浏览器里打开 Grafana 的地址，末尾带 `/`。Nginx 示例见 [nginx.example.conf](nginx.example.conf)。`SENTRY_AUTH_TOKEN` 在 Sentry 组织里创建 Auth Token（`org:read`、`project:read`、`event:read`），写入 `.env` 后重启 Grafana。

拉 API 镜像（需能访问 GHCR；私有包先 `docker login ghcr.io`）：

```bash
docker pull ghcr.io/1024xengineer/timeflow-backend:latest
```

国内访问 Docker Hub 超时，不要直接 `compose up` 拉 Grafana 三件套，先镜像再打回原名：

```bash
docker pull docker.m.daocloud.io/grafana/grafana:11.5.2
docker pull docker.m.daocloud.io/grafana/tempo:2.7.1
docker pull docker.m.daocloud.io/prom/prometheus:v2.55.1
docker tag docker.m.daocloud.io/grafana/grafana:11.5.2 grafana/grafana:11.5.2
docker tag docker.m.daocloud.io/grafana/tempo:2.7.1 grafana/tempo:2.7.1
docker tag docker.m.daocloud.io/prom/prometheus:v2.55.1 prom/prometheus:v2.55.1
```

启动（不要 `--build`，不要 `down -v`）：

```bash
cd /opt/timeflow
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d --pull never
```

`--pull never` 使用刚 tag 好的本地镜像。Prometheus 依赖 API healthcheck；overlay 里已带上，即使基础 Compose 漏了也能起。

核对：

```bash
curl -sS http://127.0.0.1:8000/api/v1/health
curl -sS http://127.0.0.1:3000/api/health
docker compose -f docker-compose.yml -f docker-compose.observability.yml \
  exec prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets
```

`timeflow` target 应为 `up`。公网不要暴露 `/metrics`、9090、3200、4318。

Grafana 装 Sentry 插件需要访问 grafana.com。失败时在 `.env` 写成 `GF_INSTALL_PLUGINS=`（空字符串，不要删掉这一行）再 `up -d grafana`；服务端看板仍可用。

## 本机（有源码）

```bash
cp .env.example .env
# 填写 TIMEFLOW_JWT_SECRET 与 GRAFANA_ADMIN_PASSWORD
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d --build
```

本机 Grafana：`http://127.0.0.1:3000`。
