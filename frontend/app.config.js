module.exports = {
  expo: {
    name: 'Timeflow',
    slug: 'timeflow',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSMicrophoneUsageDescription: '需要麦克风权限来录制语音指令',
        NSLocationWhenInUseUsageDescription: '需要定位权限来关联语音指令发生的地点',
        UIBackgroundModes: ['location'],
      },
      bundleIdentifier: 'com.anonymous.timeflow',
    },
    android: {
      package: 'com.anonymous.timeflow',
      permissions: [
        'RECORD_AUDIO',
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'FOREGROUND_SERVICE',
        'FOREGROUND_SERVICE_LOCATION',
        'SCHEDULE_EXACT_ALARM',
        'POST_NOTIFICATIONS',
        'USE_FULL_SCREEN_INTENT',
        'SYSTEM_ALERT_WINDOW',
        'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        'FOREGROUND_SERVICE_MEDIA_PLAYBACK',
        'VIBRATE',
      ],
      adaptiveIcon: {
        backgroundColor: '#E6F4FE',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      'expo-sqlite',
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission:
            '允许 Timeflow 使用你的位置，以便在到达或离开地点时提醒你。',
          locationWhenInUsePermission: '允许 Timeflow 在使用期间访问位置，以便地点提醒生效。',
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
        },
      ],
      '@irvingouj/expo-audio-stream',
      [
        'expo-audio',
        {
          microphonePermission: '需要麦克风权限来录制语音指令',
          enableBackgroundPlayback: true,
        },
      ],
      [
        'expo-notifications',
        {
          icon: './assets/icon.png',
          color: '#15352B',
          defaultChannel: 'timeflow-reminders',
        },
      ],
    ],
  },
};
