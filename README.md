# Timeflow

**让时间真正流动起来的智能日程与目标助手。**

Timeflow 面向需要同时管理日程、待办与长期目标的个人用户，把「记下要做什么」升级为「帮你安排、拆解、调整与复盘」。你可以用文字、语音或图片表达意图；系统理解后给出可执行的安排，并在计划偏离时帮助你重新排程。

> 当前仓库处于架构骨架与基础设施阶段：API、数据库迁移、质量门禁与 Agent / 业务目录边界已就绪，核心业务能力将按模块逐步落地。

---

## 产品定位

传统待办工具擅长记录，却很少帮你回答更难的问题：

- 这件事该插在今天的哪一段空档？
- 一个模糊目标如何拆成可执行步骤？
- 突发冲突出现时，整周计划如何最小代价地重排？
- 执行一段时间后，该如何复盘并改进下一次安排？

Timeflow 的目标是成为**时间决策的协同方**：不只存事项，还参与调度、拆解、重排与反馈闭环，让计划跟着真实生活持续流动。

---

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 日程与待办调度 | 创建、调整日程与待办，结合已有安排给出可落地的时间建议 |
| 任务拆解 | 将模糊目标拆成可执行的子任务与阶段性计划 |
| 智能重排 | 在冲突、延期或优先级变化时，重新规划后续时间线 |
| 执行反馈 | 记录完成情况与偏差，为后续调度提供依据 |
| 周期复盘 | 对目标与时间使用进行回顾，沉淀可复用的改进建议 |
| 多模态输入 | 支持文字、语音（ASR）与图片（OCR）表达意图 |
| 日程视图 | 按时间展示日程、待办与目标任务，支持确认后的统一查看与操作 |

消息提醒等端侧能力由移动端负责；后端聚焦理解、规划与事实数据管理。

---

## 目标架构（概览）

Timeflow 的 Agent 协作采用「主入口 + 专项能力」的职责划分，并与非 Agent 业务边界并存。下图展示各模块的职责与协作关系：

```text
用户（Android App）
        │
        ▼
   主 Agent（唯一对话 / 编排入口）
        │
        ├── 日程待办 Agent
        ├── 任务拆解 Agent
        ├── 重排 Agent
        ├── 复盘 Agent
        └── 反馈 Agent
        │
        ▼
   公共事实数据 / 用户画像 / 对象存储
```

- **主 Agent（目标职责）**：对外提供唯一 Agent HTTP 入口，负责理解意图、追问补全、确认写操作与结果编排。
- **专项 Agent（目标职责）**：作为进程内能力包，专注各自领域推理，不直接对外暴露接口、不直接落库。
- **Basic 业务**：身份、用户画像、OCR / ASR、用量管理等非对话型产品能力。
- **Common 能力**：公共数据读写、LLM 调用、任务画像、对象存储与系统日志等横切支撑。

详细目录说明见 [docs/project-structure.md](docs/project-structure.md)。

---

## 技术栈

| 层级 | 选型 |
| --- | --- |
| 移动端 | Expo React Native（目标平台 **Android**）+ TypeScript |
| API | FastAPI + SQLAlchemy + Alembic |
| 数据 | PostgreSQL 16 |
| 工程 | uv（后端） / npm（前端），Docker Compose 本地栈 |

运行时版本基线：Node.js `>=20.20.2 <21`、Python `>=3.11,<3.12`（Docker 使用 `3.11.15`）、uv `0.11.28`、PostgreSQL `16.4`。依赖约定见 [docs/dependency-management.md](docs/dependency-management.md)。

---

## 快速开始

```bash
# 1. 环境文件
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# 2. 安装依赖
npm --prefix frontend ci
(cd backend && uv sync --locked --all-groups)

# 3. 启动 PostgreSQL + API（容器会先执行 alembic upgrade head）
docker compose up --build
```

- API 健康检查：<http://127.0.0.1:8000/api/v1/health>
- 仅启动移动端：`npm --prefix frontend run start`（Android：`npm --prefix frontend run android`）
- 仅本地启动 API：`cd backend && uv run alembic upgrade head && uv run uvicorn timeapp.main:app --reload`
- Android 模拟器默认通过 `10.0.2.2` 访问宿主机 API；真机请将 `EXPO_PUBLIC_API_URL` 改为开发机局域网 IP

更多后端说明见 [backend/README.md](backend/README.md)。

---

## 质量与协作

```bash
bash scripts/check-all.sh            # 全量
bash scripts/check-all.sh backend    # 仅后端
bash scripts/check-all.sh frontend   # 仅前端
```

数据库迁移验证只在显式设置 `TIMEAPP_CHECK_DATABASE_URL` 时执行，并且数据库名必须以 `_test` 或 `_check` 结尾。脚本不会对应用使用的 `TIMEAPP_DATABASE_URL` 执行迁移；一旦提供检查数据库地址，配置、连接或迁移错误都会使门禁失败。

开发规范与硬性约束见 [docs/skills/dev-standards/SKILL.md](docs/skills/dev-standards/SKILL.md)。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/project-structure.md](docs/project-structure.md) | 仓库目录与模块边界 |
| [docs/dependency-management.md](docs/dependency-management.md) | 依赖与锁文件规则 |
| [docs/skills/dev-standards/SKILL.md](docs/skills/dev-standards/SKILL.md) | 开发规范 |
| [docs/skills/git-hooks/SKILL.md](docs/skills/git-hooks/SKILL.md) | Git Hooks 启用指引 |
| [backend/README.md](backend/README.md) | API 本地启动与迁移 |

---

Timeflow —— 让计划跟随生活流动，而不是让生活迁就一份过时的清单。
