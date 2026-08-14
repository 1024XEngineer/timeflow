# timeflow-baidu-location

Android 百度定位桥接（`LocationClient` 连续定位），**不使用 Google Geofencing**。

- 原生模块名：`TimeflowBaiduLocation`
- 事件：`TimeflowBaiduLocation`（latitude / longitude / accuracy / observedAt）
- 坐标系：`gcj02`
- AK 通过 Expo 插件写入 `com.baidu.lbsapi.API_KEY`

## 控制台要求

Android AK 必须与包名 **`com.timeflow`** + 签名证书 **SHA1** 绑定，否则定位会失败（常见 locType 鉴权错误）。

## 应用侧

`NativeLocationMonitor` 订阅连续定位，用 Haversine 判断进出圈。
