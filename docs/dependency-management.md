# 依赖管理

## 运行时基线

| 范围 | 工具 | 固定版本 | 权威来源 |
| --- | --- | --- | --- |
| 前端运行时 | Node.js | 20.20.2 | `.nvmrc` |
| 前端包管理器 | npm | 10.8.2 | 根目录与 `frontend/package.json` |
| 后端运行时 | Python | 3.11.15 | `.python-version` |
| 后端包管理器 | uv | 0.11.28 | Dockerfile 与 CI workflow |
| 开发数据库 | PostgreSQL | 16.4 | `docker-compose.yml` |

## 允许的命令

- 前端依赖：`npm --prefix frontend ci`
- 后端依赖：`cd backend && uv sync --locked --all-groups`
- 官方门禁：`bash scripts/check-all.sh`（或带 `backend` / `frontend` 参数）；后端在 PostgreSQL 可达时含 `alembic upgrade head` + `alembic check`
- 前端质量与安全：`npm --prefix frontend run check` 与 `npm --prefix frontend audit --audit-level=moderate`
- 后端质量：`cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest && uv run alembic history`
- 数据库迁移：`cd backend && uv run alembic upgrade head`；模型变更后 `uv run alembic revision --autogenerate -m "..."`

禁止在本仓库使用 yarn、pnpm、`pip install`、Poetry，或再引入第二套锁文件。

## 锁文件规则

- 修改 `frontend/package.json` 后必须提交 `frontend/package-lock.json`
- 修改 `backend/pyproject.toml` 后必须提交 `backend/uv.lock`
- 安装与 CI 使用 `npm ci` 和 `uv sync --locked`，二者不得改写锁文件
- 运行时依赖与开发依赖保持在各自声明的分区中

## 更新流程

1. 只改对应 manifest 里的一处依赖声明。
2. 只重新生成该包管理器的锁文件。
3. 跑对应端的质量检查与安全审计（优先 `bash scripts/check-all.sh`）。
4. 若改了 Expo 相关依赖，提交前跑 Expo Doctor 与 Android export。
