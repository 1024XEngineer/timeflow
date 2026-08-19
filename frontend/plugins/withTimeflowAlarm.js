const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const PACKAGE_NAME = 'timeflow-alarm';
const PERMISSIONS = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.VIBRATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];

/**
 * 保证应用级闹钟权限在 prebuild 后仍然保留。
 * 原生源码、AlarmPackage 自动链接与组件声明在 modules/timeflow-alarm
 * （经 Android library manifest 合并）。
 */
function withTimeflowAlarm(config) {
  config = AndroidConfig.Permissions.withPermissions(config, PERMISSIONS);
  config = withAndroidManifest(config, (config) => {
    AndroidConfig.Permissions.ensurePermissions(config.modResults, PERMISSIONS);
    return config;
  });
  return config;
}

module.exports = createRunOncePlugin(withTimeflowAlarm, PACKAGE_NAME, '1.0.0');
