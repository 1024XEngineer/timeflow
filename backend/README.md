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

## 目录结构

```text
src/timeapp/
├── agents/                 # 主 Agent 与五个子 Agent 的空目录边界
│   ├── main_agent/
│   ├── schedule_todo_agent/
│   ├── task_breakdown_agent/
│   ├── replanning_agent/
│   ├── review_agent/
│   └── feedback_agent/
├── basic/                  # 手动业务、用户画像和 OCR/ASR 模块边界
│   ├── identity/
│   ├── user_profile/
│   ├── ocr/
│   ├── asr/
│   └── usage_management/
├── common/
│   ├── data/               # 公共事实数据读写边界
│   ├── llm/                # 统一模型调用与提示词管理边界
│   ├── task_profile/       # 任务级画像管理边界
│   ├── object_storage/     # 图片和音频对象存储边界
│   └── system_logs/        # 系统日志与业务审计边界
├── api/                    # HTTP 路由聚合和基础设施探活
└── core/                   # 配置、数据库连接和基础设施
```

Agent 目录边界已经保留，具体实现将在数据库和接口设计完成后通过独立功能提交添加。消息推送按 Wiki 约束由前端实现。

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
