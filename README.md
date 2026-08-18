# TimeFlow

TimeFlow 是一款语音优先的个人日程助手，帮你用说话的方式管理时间、地点和提醒。

打开日历即可查看当天的时间日程与地点提醒；通过对话让助手帮你新建、查询、修改和删除安排。到点或到达指定地点时，会按你设定的强度提醒你。

言出成约，时至如约。

## 当前能力

- 登录或注册后查看日历
- 时间日程与地点提醒
- 语音新建、查询、修改和删除安排
- 按住说话，或进入免提连续对话
- 到点提醒，到达指定地点时也会提醒

## 它如何工作

```text
说话
  → 助手理解意图
  → 调用日程工具
  → 云端写入安排
  → 本地同步备份
  → 助手语音回复
  → 日历立刻可见
  → 按照要求提醒
```

## 快速上手

需要 Docker、Node.js 20。JWT 密钥至少 32 个 UTF-8 字节。

```bash
cp .env.example .env
# 在 .env 中设置 TIMEFLOW_JWT_SECRET
docker compose up -d --build

cd frontend
cp .env.example .env
npm ci
npm start
```

API 在 `http://127.0.0.1:8000`。Expo Web 请把 `EXPO_PUBLIC_API_URL` 设为 `http://127.0.0.1:8000/api/v1`。后端细节见 [backend/README.md](backend/README.md)。

不启动后端时，可以用 mock 预览浏览登录页和示例日历：

```bash
cd frontend
npm run web:preview
```

## 仓库结构

```text
TimeFlow/
├── frontend/   # Expo / React Native 客户端：日历、语音、本地日程与提醒
├── backend/    # FastAPI 服务：账号、日程、语音助手与地点检索
└── README.md
```

## 技术栈

- 客户端：Expo、React Native、TypeScript、SQLite
- 服务端：Python 3.11、FastAPI、PostgreSQL
- 语音与地点：通义实时语音、腾讯地图检索

## 相关入口

- 后端启动与检查：[backend/README.md](backend/README.md)
- 需求与进度：[Issues](https://github.com/1024XEngineer/timeflow/issues)
