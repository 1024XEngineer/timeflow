const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const PACKAGE_NAME = 'timeflow-voice-recorder';
const RECORD_AUDIO = 'android.permission.RECORD_AUDIO';

/** Keeps the microphone permission in generated native manifests. */
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

    return config;
  });
  return config;
}

module.exports = createRunOncePlugin(withTimeflowVoiceRecorder, PACKAGE_NAME, '1.0.0');
