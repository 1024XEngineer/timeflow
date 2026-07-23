---
name: timeflow-dev-standards
description: Timeflow 项目的开发规范与硬性约束。在本仓库中编写、修改、重构任何代码（backend FastAPI 或 frontend Expo RN）之前必须先阅读并遵守。涵盖架构分层、API 设计、数据库、前端结构、命名、注释语言、测试与安全底线，以及 AI 禁止行为清单。
---

# Timeflow 开发规范

本文件是本仓库的最高开发约束。与本文件冲突的实现一律不允许产出。
改完代码后必须运行检查（见「完工门禁」），检查不过不算完成。

## 项目概览

- `backend/`：FastAPI + SQLAlchemy + Alembic，Python ≥ 3.11，包管理用 **uv**（禁止 pip install / poetry）
- `frontend/`：Expo React Native + TypeScript strict，**目标平台为 Android**，包管理用 **npm**（禁止 yarn / pnpm），本地运行用 `npm run android`
- 后端包名 `timeapp`，src 布局：`backend/src/timeapp/`

## 完工门禁（每次改完代码必须执行）

```bash
# 只改了后端
bash scripts/check-all.sh backend
# 只改了前端
bash scripts/check-all.sh frontend
# 都改了
bash scripts/check-all.sh
```

门禁内容：后端 `ruff check` + `ruff format --check` + `mypy`（strict）+ `pytest` + `alembic history`；若本机 PostgreSQL 可达则再跑 `alembic upgrade head` + `alembic check`（CI 始终跑这两项）；前端 `eslint` + `prettier --check` + `tsc --noEmit` + `npm audit --audit-level=moderate`。
任何一项失败都必须修复后重跑，直到全绿。禁止用 `# noqa`、`# type: ignore`、`eslint-disable` 掩盖问题（确有必要时必须写明原因并在回复中向用户说明）。

## 后端架构（强制分层）

后端按 Agent 边界组织，禁止把业务写进 `api/`、`core/` 或 `main.py`：

```text
src/timeapp/
├── agents/                 # 主 Agent 与专项 Agent
│   ├── main_agent/         # 唯一 Agent HTTP 入口：router / schemas / dispatcher
│   └── <special>_agent/    # 内部能力包：schemas / service / prompts（禁止 router.py）
├── basic/                  # 非 Agent 产品边界（手动业务、事项展示、OCR/ASR 等）
│   └── <domain>/           # router / schemas / service / models（按需）
├── common/                 # 跨 Agent 契约与共享能力
│   ├── contracts/          # 统一响应等契约
│   ├── data/               # 公共事实数据读写（专项 Agent 禁止直接调用）
│   ├── confirmation/ / questioning/ / llm/ / task_profile/ / context/
├── api/                    # 路由聚合、health、dependencies
└── core/                   # Settings、DB engine / session / Base
```

- 只有 `main_agent` 暴露 Agent HTTP 入口；专项 Agent 是进程内能力包，不直接读写数据库、不追问、不执行 `db_action`
- 对外 HTTP 路由（main_agent / basic）必须在 `api/router.py` 中注册：`api_router.include_router(...)`
- 横切能力（认证、DB 会话）统一放 `api/dependencies.py`，业务包内禁止自建
- 配置只能通过 `core/config.py` 的 `Settings` 读取，禁止在业务代码里直接 `os.environ`
- `basic/<domain>/` 内部分层：`router` 只做 HTTP 编排，`service` 禁止出现 FastAPI 对象；包之间只允许调用对方 `service`，禁止跨包 import `router` / `models`
- ORM 模型放 `basic/<domain>/models.py` 或经 `common/data/` 统一出口；专项 Agent 目录禁止出现 `models.py` 与数据库导入

## API 设计

- 路径用 kebab-case（`/main-agent`、`/unified-items`），与现有前缀保持一致；资源用复数名词，禁止动词路径（`POST /todos`，不是 `/create-todo`）
- 请求/响应必须定义 Pydantic 模型并声明 `response_model`，禁止返回裸 dict
- 状态码：创建 201、删除 204、404/409 等错误用 `HTTPException` 抛出，`detail` 用英文
- 分页列表统一 query 参数 `limit`（默认 20，上限 100）+ `offset`

## 数据库

- 公共 `Base`、engine、session 放 `core/db.py`；迁移脚本放 `backend/alembic/versions/`
- 表名 snake_case 复数（`todos`、`goal_plans`）；所有表必须有 `id`、`created_at`、`updated_at`
- 任何模型变更必须生成 Alembic 迁移（`cd backend && uv run alembic revision --autogenerate -m "..."`），禁止手改历史迁移、禁止 `Base.metadata.create_all` 用于生产路径
- 应用迁移：`cd backend && uv run alembic upgrade head`
- 查询写在 service / `common/data` 层，禁止在 router 里直接操作 session

## 前端结构（Expo RN）

新代码按以下目录组织（目录不存在时按需创建）：

```text
frontend/src/
├── screens/       # 页面级组件，PascalCase：HomeScreen.tsx
├── components/    # 可复用组件，PascalCase：TodoCard.tsx
├── hooks/         # 自定义 hook，camelCase：useTodos.ts
├── api/           # 后端 API 封装，统一 fetch 客户端
├── types/         # 共享 TS 类型
└── constants/     # 颜色、间距等设计常量
```

- 一律函数组件 + hooks，禁止 class 组件；组件 props 必须有显式 TS 类型
- 样式用 `StyleSheet.create`，禁止大段内联样式对象；颜色/间距取自 `constants/`
- 禁止 `any`（确需未知类型用 `unknown` 再收窄）；tsconfig strict 不得关闭
- 调用后端必须经过 `src/api/` 封装层，组件内禁止直接写 fetch/URL

### Android 适配（目标平台）

- 一切 UI 与交互以 Android 为准验收，禁止引入 iOS-only API（如 `ActionSheetIOS`）
- 阴影用 `elevation`，禁止只写 iOS 的 `shadow*` 系列样式
- 必须处理 Android 物理返回键的页面退出逻辑（`BackHandler` 或导航库默认行为）
- 系统权限（通知、麦克风、相册等）在 `app.json` 的 `android.permissions` 中声明，并在代码中运行时请求
- 刘海屏/状态栏适配用 `SafeAreaView`/safe-area 方案，不写死状态栏高度

## 命名与语言

- Python：模块/函数/变量 snake_case，类 PascalCase；TS：变量/函数 camelCase，组件/类型 PascalCase
- 注释和 docstring 用**中文**；标识符、日志、错误信息、commit scope 用**英文**
- 只写解释「为什么」的注释，禁止复述代码行为的废话注释

## 测试（硬性要求）

- 新增或修改业务逻辑（service 层、非空壳 router、工具函数）必须同步补/改 pytest 测试，放 `backend/tests/test_<模块>.py`
- API 测试用 `fastapi.testclient.TestClient`，覆盖正常路径 + 至少一个错误路径
- 改完必须实际运行 `uv run pytest` 并通过；禁止提交只为凑数、无断言的测试

## 安全底线

- 密钥、token、连接串只能走环境变量（`TIMEAPP_` 前缀）+ `.env`（已 gitignore），新增变量必须同步更新 `.env.example`（放占位值）
- 禁止把 `.env`、真实密钥、用户数据写进代码、测试、文档
- SQL 只能通过 ORM / 绑定参数，禁止字符串拼接 SQL
- 禁止 `print` 调试（ruff T20 会拦截）；日志不得输出密码、token、个人敏感信息
- 后端禁止吞异常（裸 `except: pass`）；对外错误信息不暴露堆栈和内部路径

## AI 禁止行为清单

1. 禁止未经用户同意引入新依赖、新框架、新服务（改 pyproject.toml / package.json 依赖前必须先说明理由并征得同意）
2. 禁止修改与当前任务无关的代码、重排无关 import、顺手重构
3. 禁止留 TODO 空壳函数、`pass` 占位实现交差；做不完就明确告诉用户哪部分没做
4. 禁止降低门禁：不得删除/放宽 ruff、mypy、eslint、tsconfig 的现有配置
5. 禁止操作 git：不 init、不 commit、不 push，git 操作一律由用户自己执行。唯一例外：用户明确要求启用 hooks 时，按 `timeflow-git-hooks` skill 写 `.git/hooks/` 下的三个文件
6. 禁止编造不存在的 API、库用法；不确定就先查证
7. 禁止跳过「完工门禁」就宣称任务完成

## Commit 规范（供用户参考，hooks 强制）

提交信息请遵循 Conventional Commits 规范，详见 <https://www.conventionalcommits.org/zh-hans/v1.0.0/>。
格式 `type(scope): 描述`，type 限 feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert，scope 用英文模块名，描述可中文，标题 ≤ 72 字符。示例：`feat(scheduling): 新增待办创建接口`。
启用拦截：用户提出需求后，按 `.cursor/skills/timeflow-git-hooks/SKILL.md` 创建 hooks（pre-commit 检查改动端、commit-msg 校验格式、pre-push 全量检查）。
