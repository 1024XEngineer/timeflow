# timeflow-alarm

本地 React Native Android 库，对外提供 `NativeModules.TimeflowAlarm`。

`android/` 下源码纳入版本管理。应用级权限由 `plugins/withTimeflowAlarm.js` 在 `expo prebuild` 时注入。Autolinking 通过 `react-native.config.js` 与 `file:modules/timeflow-alarm` 依赖注册 `AlarmPackage`。
