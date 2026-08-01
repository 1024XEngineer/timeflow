const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const PACKAGE_NAME = 'timeflow-voice-recorder';
const RECORD_AUDIO = 'android.permission.RECORD_AUDIO';

/** Keeps microphone and LAN ws:// support in generated release manifests. */
function withTimeflowVoiceRecorder(config) {
  config = AndroidConfig.Permissions.withPermissions(config, [RECORD_AUDIO]);
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    AndroidConfig.Permissions.ensurePermissions(manifest, [RECORD_AUDIO]);

    for (const permission of manifest.manifest['uses-permission'] ?? []) {
      if (permission.$?.['android:name'] === RECORD_AUDIO) {
        delete permission.$['tools:node'];
      }
    }

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    application.$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
  return config;
}

module.exports = createRunOncePlugin(withTimeflowVoiceRecorder, PACKAGE_NAME, '1.0.0');
