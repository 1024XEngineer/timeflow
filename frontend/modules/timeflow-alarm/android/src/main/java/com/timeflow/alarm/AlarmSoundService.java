package com.timeflow.alarm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.ActivityOptions;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

public final class AlarmSoundService extends Service {
    private static final long SPEECH_REPEAT_DELAY_MILLIS = 1_500L;

    private final Handler playbackHandler = new Handler(Looper.getMainLooper());
    private final Runnable replaySpeech = this::replaySpeech;

    private MediaPlayer mediaPlayer;
    private boolean destroyed;
    private File bundledSpeechFile;
    private WindowManager overlayWindowManager;
    private View overlayView;
    private String alarmId;
    private String scheduleId;
    private String alarmTitle;
    private int requestCode;
    private boolean firedNotified;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        requestCode = intent == null
                ? 0
                : intent.getIntExtra(AlarmContract.EXTRA_REQUEST_CODE, 0);
        alarmId = intent == null
                ? null
                : intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID);
        scheduleId = intent == null
                ? null
                : intent.getStringExtra(AlarmContract.EXTRA_SCHEDULE_ID);
        alarmTitle = intent == null
                ? null
                : intent.getStringExtra(AlarmContract.EXTRA_TITLE);
        if (alarmId == null || alarmId.isEmpty()) {
            alarmId = "legacy-" + requestCode;
        }
        if (scheduleId == null || scheduleId.isEmpty()) {
            scheduleId = AlarmScheduler.scheduleIdForAlarm(this, alarmId);
        }
        if (alarmTitle == null || alarmTitle.isEmpty()) {
            alarmTitle = "日程提醒";
        }

        createNotificationChannel();
        Notification notification = buildNotification(alarmId, alarmTitle);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                        requestCode,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                );
            } else {
                startForeground(requestCode, notification);
            }
            removeFromSavedAlarms();
            if (!firedNotified) {
                firedNotified = true;
                AlarmNativeBridge.notifyFired(this, scheduleId, alarmId, alarmTitle);
            }
            showAlarmOverlay(alarmTitle);
            if (mediaPlayer == null) {
                startBundledSpeech();
            }
        } catch (RuntimeException exception) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        playbackHandler.removeCallbacksAndMessages(null);
        removeAlarmOverlay();
        releaseMediaPlayer();
        deleteCachedSpeechFile();
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(requestCode);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, AlarmSoundService.class));
    }

    static void start(
            Context context,
            String alarmId,
            String scheduleId,
            int requestCode,
            String title
    ) {
        Intent intent = new Intent(context, AlarmSoundService.class)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    private Notification buildNotification(String alarmId, String title) {
        Intent ringIntent = new Intent(this, RingActivity.class)
                .setData(alarmUri(alarmId))
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_MULTIPLE_TASK
                        | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        PendingIntent fullScreenIntent = PendingIntent.getActivity(
                this,
                requestCode,
                ringIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE,
                pendingIntentOptions()
        );
        return new Notification.Builder(this, AlarmContract.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(title)
                .setContentText("点击停止提醒")
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setPriority(Notification.PRIORITY_MAX)
                .setOngoing(true)
                .setAutoCancel(false)
                .setFullScreenIntent(fullScreenIntent, true)
                .build();
    }

    private Uri alarmUri(String value) {
        return AlarmScheduler.alarmUri(value);
    }

    private android.os.Bundle pendingIntentOptions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return null;
        }
        ActivityOptions options = ActivityOptions.makeBasic();
        options.setPendingIntentCreatorBackgroundActivityStartMode(
                backgroundActivityStartMode()
        );
        return options.toBundle();
    }

    private int backgroundActivityStartMode() {
        if (Build.VERSION.SDK_INT >= 36) {
            return ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS;
        }
        return ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(AlarmContract.CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                AlarmContract.CHANNEL_ID,
                "Timeflow",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("日程闹钟提醒");
        channel.enableVibration(true);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void showAlarmOverlay(String title) {
        if (overlayView != null
                || Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || !Settings.canDrawOverlays(this)) {
            return;
        }

        overlayWindowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (overlayWindowManager == null) {
            return;
        }

        View content = AlarmRingUi.build(
                this,
                title,
                view -> {
                    long triggerAt = System.currentTimeMillis()
                            + AlarmContract.SNOOZE_MINUTES * 60_000L;
                    try {
                        AlarmScheduler.schedule(this, triggerAt, alarmTitle, scheduleId);
                    } catch (RuntimeException ignored) {
                        // ignore
                    }
                    AlarmNativeBridge.notifySnoozed(this, scheduleId, alarmId, alarmTitle);
                    removeAlarmOverlay();
                    RingActivity.finishIfOpen();
                    stopSelf();
                },
                view -> {
                    AlarmNativeBridge.notifyDismissed(this, scheduleId, alarmId, alarmTitle);
                    removeAlarmOverlay();
                    RingActivity.finishIfOpen();
                    stopSelf();
                }
        );
        int windowType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_SYSTEM_ALERT;
        int windowFlags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN;
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                windowType,
                windowFlags,
                PixelFormat.OPAQUE
        );
        params.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        content.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        try {
            overlayWindowManager.addView(content, params);
            overlayView = content;
        } catch (RuntimeException exception) {
            overlayWindowManager = null;
        }
    }

    private void removeAlarmOverlay() {
        if (overlayWindowManager != null && overlayView != null) {
            try {
                overlayWindowManager.removeViewImmediate(overlayView);
            } catch (RuntimeException ignored) {
                // 系统可能已移除悬浮窗。
            }
        }
        overlayView = null;
        overlayWindowManager = null;
    }

    private void startBundledSpeech() {
        if (destroyed || mediaPlayer != null) {
            return;
        }
        try {
            bundledSpeechFile = new File(getCacheDir(), "alarm_prompt_edge.mp3");
            try (InputStream input = getAssets().open("alarm_prompt.mp3");
                 FileOutputStream output = new FileOutputStream(bundledSpeechFile, false)) {
                byte[] buffer = new byte[8_192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                }
            }
            startAudioPlayback(bundledSpeechFile);
        } catch (Exception exception) {
            releaseMediaPlayer();
        }
    }

    private void startAudioPlayback(File audioFile) {
        if (destroyed || mediaPlayer != null || audioFile == null || !audioFile.isFile()) {
            return;
        }
        try {
            MediaPlayer player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            player.setDataSource(audioFile.getAbsolutePath());
            player.setVolume(1.0f, 1.0f);
            player.setOnCompletionListener(completed ->
                    playbackHandler.postDelayed(replaySpeech, SPEECH_REPEAT_DELAY_MILLIS));
            player.setOnErrorListener((failed, what, extra) -> {
                releaseMediaPlayer();
                return true;
            });
            player.prepare();
            mediaPlayer = player;
            player.start();
        } catch (Exception exception) {
            releaseMediaPlayer();
        }
    }

    private void replaySpeech() {
        if (destroyed || mediaPlayer == null) {
            return;
        }
        try {
            mediaPlayer.seekTo(0);
            mediaPlayer.start();
        } catch (IllegalStateException ignored) {
            releaseMediaPlayer();
        }
    }

    private void releaseMediaPlayer() {
        playbackHandler.removeCallbacks(replaySpeech);
        if (mediaPlayer == null) {
            return;
        }
        mediaPlayer.setOnCompletionListener(null);
        mediaPlayer.setOnErrorListener(null);
        try {
            mediaPlayer.stop();
        } catch (IllegalStateException ignored) {
            // 播放器可能已结束或失败。
        }
        mediaPlayer.release();
        mediaPlayer = null;
    }

    private void deleteCachedSpeechFile() {
        if (bundledSpeechFile != null) {
            bundledSpeechFile.delete();
        }
    }

    private void removeFromSavedAlarms() {
        AlarmScheduler.removeAlarmRecord(this, alarmId, requestCode);
    }

}
