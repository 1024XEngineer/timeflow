# Timeflow

Timeflow 采用单仓库布局，包含 FastAPI 后端和 Expo React Native 移动端。

```text
backend/   # FastAPI API 服务
frontend/  # Expo React Native 应用（TypeScript）
```

## 后端

```bash
cd backend
cp .env.example .env  # 可选
uv sync
uv run uvicorn timeapp.main:app --reload
```

API 健康检查：<http://127.0.0.1:8000/api/v1/health>

## 移动端

```bash
cd frontend
npm install
npm run start
```

目标平台为 Android，日常开发用 `npm run android` 在模拟器/真机上运行。

## 开发规范与质量检查

开发规范见 `.cursor/skills/timeflow-dev-standards/SKILL.md`（AI 会在每次改代码前强制加载）。

- 后端：Ruff（lint + format）、mypy strict、pytest，配置在 `backend/pyproject.toml`
- 前端：ESLint（expo 规则集）、Prettier、tsc，脚本在 `frontend/package.json`

一键全量检查：

```bash
bash scripts/check-all.sh            # 前后端全部
bash scripts/check-all.sh backend    # 仅后端
bash scripts/check-all.sh frontend   # 仅前端
```

## Git hooks（提交/推送拦截）

hooks 不预置在仓库中。git 仓库就绪后，在 Cursor 里对 AI 说「启用 git hooks」，AI 会按
`.cursor/skills/timeflow-git-hooks/SKILL.md` 中的模板把三个 hook 写入 `.git/hooks/` 并验证：

- `pre-commit`：按改动范围跑对应端检查，不过不让提交
- `commit-msg`：强制 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 的 `type(scope): 描述` 格式（feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert）
- `pre-push`：全量检查通过才允许推送

停用：删除 `.git/hooks/` 下对应文件即可。
