# 项目结构

```text
timeflow/
├── .env.example                 # Docker Compose 开发默认值
├── backend/
│   ├── Dockerfile
│   ├── docker-entrypoint.sh     # 启动前执行 alembic upgrade head
│   ├── alembic.ini              # Alembic 配置（连接串来自 Settings）
│   ├── alembic/                 # 迁移环境与 versions/
│   ├── pyproject.toml
│   ├── uv.lock
│   ├── README.md
│   ├── src/timeapp/
│   │   ├── agents/              # 主 Agent 与五个子 Agent 的空目录边界
│   │   ├── api/                 # HTTP 路由聚合与健康检查
│   │   ├── basic/               # 手动业务、用户画像与 OCR/ASR 边界
│   │   ├── common/              # 数据、LLM、任务画像、对象存储与日志边界
│   │   └── core/                # 配置与数据库基础设施
│   └── tests/
├── docs/
│   ├── project-structure.md
│   ├── dependency-management.md
│   └── skills/                  # 开发规范与 git hooks 指引
│       ├── dev-standards/
│       └── git-hooks/
├── frontend/
│   ├── .env.example             # Android 模拟器 API 基址
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── api/
│       ├── constants/
│       └── screens/
├── docker-compose.yml           # API 与 PostgreSQL 开发栈
└── scripts/check-all.sh         # 官方完工门禁
```

`agents/` 及其主 Agent、五个子 Agent 目录保留为空（仅 `__init__.py`），实现文件将在数据库和接口设计完成后添加。`common/` 负责共享数据、LLM、任务画像、对象存储和系统日志；`basic/` 负责非 Agent 产品边界。消息推送由前端实现。
