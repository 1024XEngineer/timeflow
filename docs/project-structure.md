# 项目结构

```text
timeflow/
├── .env.example                 # Docker Compose 开发默认值
├── .github/workflows/ci.yml     # 质量、安全、导出与容器检查
├── backend/
│   ├── Dockerfile
│   ├── docker-entrypoint.sh     # 启动前执行 alembic upgrade head
│   ├── alembic.ini              # Alembic 配置（连接串来自 Settings）
│   ├── alembic/                 # 迁移环境与 versions/
│   ├── pyproject.toml
│   ├── uv.lock
│   ├── README.md
│   ├── src/timeapp/
│   │   ├── agents/              # 主 Agent 与专项 Agent 骨架
│   │   ├── api/                 # HTTP 路由聚合与健康检查
│   │   ├── basic/               # 手动业务与 OCR/ASR 边界
│   │   ├── common/              # 契约与共享能力边界
│   │   └── core/                # 配置与数据库基础设施
│   └── tests/
├── docs/
│   ├── dependency-management.md
│   └── project-structure.md
├── frontend/
│   ├── .env.example             # Android 模拟器 API 基址
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── api/
│       ├── constants/
│       └── screens/
├── docker-compose.yml           # API 与 PostgreSQL 开发栈
├── package.json                 # 仅跨项目统一命令入口
└── scripts/check-all.sh         # 官方完工门禁
```

`agents/` 只放编排与能力框架，不包含已实现的 LLM、确认、CRUD 或数据库业务逻辑。`common/` 负责跨 Agent 契约与后续共享能力；`basic/` 负责非 Agent 产品边界。
