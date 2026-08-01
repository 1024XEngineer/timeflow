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
 * Ensures app-level alarm permissions survive prebuild.
 * Native sources, AlarmPackage autolinking, and component declarations live in
 * modules/timeflow-alarm (merged via the Android library manifest).
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
