# Timeflow API

后端使用 Python 3.11、uv、FastAPI、SQLAlchemy、Alembic 和 PostgreSQL。

## 本地启动

```bash
cp .env.example .env
uv sync --locked --all-groups
uv run alembic upgrade head
uv run uvicorn timeapp.main:app --reload
```

如果本机没有 PostgreSQL，使用仓库根目录的 Compose（容器启动时会自动执行迁移）：

```bash
docker compose up --build
```

健康检查：<http://127.0.0.1:8000/api/v1/health>

## Agent 目录边界

```text
src/timeapp/
├── agents/                 # 主 Agent 和专项 Agent
│   ├── main_agent/         # 唯一 Agent HTTP 入口和内部调度
│   │   ├── router.py
│   │   ├── schemas.py
│   │   └── dispatcher.py
│   ├── schedule_todo_agent/    # schemas.py + service.py + prompts.py
│   ├── task_breakdown_agent/   # schemas.py + service.py + prompts.py
│   ├── replanning_agent/       # schemas.py + service.py + prompts.py
│   ├── review_agent/           # schemas.py + service.py + prompts.py
│   └── feedback_agent/         # schemas.py + service.py + prompts.py
├── basic/                  # 手动业务、事项展示和 OCR/ASR
│   ├── identity/
│   ├── timeline/
│   ├── reminders/
│   ├── multimodal/
│   └── usage_management/
├── common/                 # 跨 Agent 契约与共享能力
│   ├── contracts/          # 统一响应、会话等契约
│   ├── data/               # 公共事实数据读写
│   ├── confirmation/       # 确认
│   ├── questioning/        # 反问
│   ├── llm/                # LLM 边界
│   ├── task_profile/       # 任务级画像
│   └── context/            # 上下文
├── api/                    # HTTP 路由聚合和基础设施探活
└── core/                   # 配置、数据库连接和基础设施
```

专项 Agent 是进程内能力包，不暴露 HTTP Router。它们只接收主 Agent 整理好的完整参数，返回 `AgentResponse`；不直接访问数据库、不负责追问，也不直接执行 `db_action`。所有写操作必须由主 Agent 在用户确认和公共数据校验后落盘。

## 数据库迁移（Alembic）

连接串来自 `TIMEAPP_DATABASE_URL`（见 `.env.example`），不要写进 `alembic.ini`。

```bash
# 应用迁移到最新
uv run alembic upgrade head

# 模型变更后生成迁移（需先在 alembic/env.py 导入新 models 模块）
uv run alembic revision --autogenerate -m "describe change"

# 查看当前版本
uv run alembic current
```

迁移脚本位于 `alembic/versions/`。禁止手改已提交的历史迁移；禁止用 `Base.metadata.create_all` 走生产建表路径。
Docker 镜像通过 `docker-entrypoint.sh` 在启动 uvicorn 前自动执行 `alembic upgrade head`。

## 测试与检查

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

或在仓库根目录执行官方门禁：`bash scripts/check-all.sh backend`。
