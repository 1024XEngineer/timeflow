# 依赖管理

## 运行时基线

| 范围 | 工具 | 版本基线 | 权威来源 |
| --- | --- | --- | --- |
| 前端运行时 | Node.js | `>=20.20.2 <21` | `frontend/package.json`（`engines`） |
| 前端包管理器 | npm | 10.8.2 | `frontend/package.json`（`engines` / `packageManager`） |
| 后端运行时 | Python | `>=3.11,<3.12`（Docker：3.11.15） | `backend/pyproject.toml`（版本范围）与 `backend/Dockerfile`（精确版本） |
| 后端包管理器 | uv | 0.11.28 | `backend/Dockerfile` |
| 开发数据库 | PostgreSQL | 16.4 | `docker-compose.yml` |

## 允许的命令

- 前端依赖：`npm --prefix frontend ci`
- 后端依赖：`cd backend && uv sync --locked --all-groups`
- 官方门禁：`bash scripts/check-all.sh`（或带 `backend` / `frontend` 参数）；显式设置 `TIMEAPP_CHECK_DATABASE_URL` 后，后端还会执行 `alembic upgrade head` + `alembic check`
- 前端质量与安全：`npm --prefix frontend run check` 与 `npm --prefix frontend audit --audit-level=moderate`
- 后端质量：`cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest && uv run alembic history`
- 数据库迁移：`cd backend && uv run alembic upgrade head`；模型变更后 `uv run alembic revision --autogenerate -m "..."`

开发环境禁止使用 yarn、pnpm、`pip install`、Poetry，或再引入第二套锁文件；`backend/Dockerfile` 仅使用 pip 安装固定版本的 uv 作为构建引导。

数据库迁移检查不得复用应用的 `TIMEAPP_DATABASE_URL`。检查数据库必须通过 `TIMEAPP_CHECK_DATABASE_URL` 显式提供，名称以 `_test` 或 `_check` 结尾，并且只用于可随时重建的数据；配置、连接或迁移失败会直接终止门禁。未设置时脚本会明确警告迁移检查未运行。

## 锁文件规则

- 修改 `frontend/package.json` 后必须提交 `frontend/package-lock.json`
- 修改 `backend/pyproject.toml` 后必须提交 `backend/uv.lock`
- 安装与质量检查使用 `npm ci` 和 `uv sync --locked`，二者不得改写锁文件
- 运行时依赖与开发依赖保持在各自声明的分区中

## 更新流程

1. 只改对应 manifest 里的一处依赖声明。
2. 只重新生成该包管理器的锁文件。
3. 跑对应端的质量检查与安全审计（优先 `bash scripts/check-all.sh`）。
4. 若改了 Expo 相关依赖，提交前跑 Expo Doctor 与 Android export。
