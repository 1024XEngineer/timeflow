const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const PACKAGE_NAME = 'timeflow-baidu-location';
const PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.CHANGE_WIFI_STATE',
  'android.permission.INTERNET',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
];

/**
 * 注入百度定位 AK（com.baidu.lbsapi.API_KEY）与相关权限。
 * 原生 LocationClient / Service 在 modules/timeflow-baidu-location。
 *
 * app.json:
 *   ["./plugins/withTimeflowBaiduLocation", { "apiKey": "YOUR_AK" }]
 */
function withTimeflowBaiduLocation(config, props = {}) {
  const apiKey = typeof props.apiKey === 'string' ? props.apiKey.trim() : '';
  if (!apiKey) {
    throw new Error(
      'withTimeflowBaiduLocation: missing apiKey. Pass { apiKey } in app.json plugins.',
    );
  }

  config = AndroidConfig.Permissions.withPermissions(config, PERMISSIONS);
  config = withAndroidManifest(config, (config) => {
    AndroidConfig.Permissions.ensurePermissions(config.modResults, PERMISSIONS);
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    ensureMetaData(app, 'com.baidu.lbsapi.API_KEY', apiKey);
    return config;
  });
  return config;
}

function ensureMetaData(application, name, value) {
  if (!application['meta-data']) {
    application['meta-data'] = [];
  }
  const list = application['meta-data'];
  const existing = list.find((item) => item?.$?.['android:name'] === name);
  if (existing) {
    existing.$['android:value'] = value;
    return;
  }
  list.push({
    $: {
      'android:name': name,
      'android:value': value,
    },
  });
}

module.exports = createRunOncePlugin(withTimeflowBaiduLocation, PACKAGE_NAME, '1.0.0');
