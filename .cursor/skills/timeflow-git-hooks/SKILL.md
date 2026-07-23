---
name: timeflow-git-hooks
description: 按模板为 Timeflow 仓库创建并启用 git hooks（pre-commit / commit-msg / pre-push 质量与提交信息拦截）。当用户要求安装、启用、创建、更新或修复 git hooks、提交拦截、push 拦截时使用。AI 依据本文件将 hook 脚本写入 .git/hooks/ 并验证。
---

# Timeflow Git Hooks 创建

按本文件模板把三个 hook 写入 `.git/hooks/`，实现：提交前跑质量检查、提交信息强制 `type(scope): 描述`、推送前全量检查。
提交信息遵循 Conventional Commits 规范，详见 <https://www.conventionalcommits.org/zh-hans/v1.0.0/>。

## 前置条件

1. 仓库根目录必须存在 `.git/`。不存在时**停止**并提示用户先自行 `git init`，禁止代替用户执行。
2. `scripts/check-all.sh` 必须存在且可执行（hooks 依赖它）。缺失时先修复此依赖再继续。
3. 仅在用户明确要求启用/更新 hooks 时执行本流程；这是「禁止操作 git」约束的唯一例外，且例外范围仅限写 `.git/hooks/` 下的这三个文件。

## 创建步骤

用 Write 工具将下面三个模板**原样**写入对应路径（已存在同名 hook 时先向用户确认再覆盖），然后：

```bash
chmod +x .git/hooks/pre-commit .git/hooks/commit-msg .git/hooks/pre-push
```

### 模板 1：`.git/hooks/pre-commit`

```bash
#!/usr/bin/env bash
# 提交前拦截：只检查本次提交涉及的端，检查不通过则禁止提交。
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
STAGED="$(git diff --cached --name-only --diff-filter=ACMR)"

[[ -z "$STAGED" ]] && exit 0

if echo "$STAGED" | grep -q '^backend/'; then
  "$ROOT/scripts/check-all.sh" backend || {
    echo ""
    echo "[pre-commit] 后端检查未通过，提交已被拦截。"
    exit 1
  }
fi

if echo "$STAGED" | grep -q '^frontend/'; then
  "$ROOT/scripts/check-all.sh" frontend || {
    echo ""
    echo "[pre-commit] 前端检查未通过，提交已被拦截。"
    exit 1
  }
fi

exit 0
```

### 模板 2：`.git/hooks/commit-msg`

```bash
#!/usr/bin/env bash
# 提交信息拦截：必须符合 Conventional Commits 格式。
# 格式: type(scope)?: 描述    例如: feat(scheduling): 新增待办创建接口
set -uo pipefail

MSG_FILE="$1"
SUBJECT="$(head -n 1 "$MSG_FILE")"

# merge/revert 等 git 自动生成的信息直接放行
if echo "$SUBJECT" | grep -qE '^(Merge|Revert|fixup!|squash!)'; then
  exit 0
fi

PATTERN='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_-]+\))?(!)?: .+'

if ! echo "$SUBJECT" | grep -qE "$PATTERN"; then
  echo "[commit-msg] 提交信息不符合规范，已被拦截。"
  echo ""
  echo "  要求格式: type(scope): 描述"
  echo "  允许类型: feat fix docs style refactor perf test build ci chore revert"
  echo "  示例:     feat(scheduling): 新增待办创建接口"
  echo "            fix(reminders): 修复提醒时间时区错误"
  echo ""
  echo "  当前信息: $SUBJECT"
  exit 1
fi

if [[ "${#SUBJECT}" -gt 72 ]]; then
  echo "[commit-msg] 标题超过 72 字符（当前 ${#SUBJECT}），请精简后重试。"
  exit 1
fi

exit 0
```

### 模板 3：`.git/hooks/pre-push`

```bash
#!/usr/bin/env bash
# 推送前拦截：全量检查（后端 + 前端）通过后才允许 push。
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"

"$ROOT/scripts/check-all.sh" || {
  echo ""
  echo "[pre-push] 检查未通过，推送已被拦截。修复后重新 push。"
  exit 1
}

exit 0
```

## 验证步骤（创建后必须执行）

不实际执行 commit/push，只做无副作用验证：

```bash
# 1. 语法检查
bash -n .git/hooks/pre-commit && bash -n .git/hooks/commit-msg && bash -n .git/hooks/pre-push

# 2. commit-msg 逻辑：合法信息应放行、非法信息应拦截
T=$(mktemp)
echo "feat(scheduling): 新增待办创建接口" > "$T" && bash .git/hooks/commit-msg "$T"   # 应通过
echo "随便改改" > "$T" && bash .git/hooks/commit-msg "$T"                              # 应拦截（退出码 1）
rm -f "$T"

# 3. 确认可执行权限
ls -l .git/hooks/pre-commit .git/hooks/commit-msg .git/hooks/pre-push
```

三项全部符合预期后，向用户报告 hooks 已启用；任何一项异常必须修复后重新验证。

## 停用方式（告知用户即可，不主动执行）

删除对应文件即可：`rm .git/hooks/pre-commit .git/hooks/commit-msg .git/hooks/pre-push`
