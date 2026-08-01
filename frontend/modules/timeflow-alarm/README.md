# timeflow-alarm

Local React Native Android library providing `NativeModules.TimeflowAlarm`.

Sources under `android/` are version-controlled. App-level permissions are injected by `plugins/withTimeflowAlarm.js` during `expo prebuild`. Autolinking registers `AlarmPackage` via `react-native.config.js` / the `file:modules/timeflow-alarm` dependency.
