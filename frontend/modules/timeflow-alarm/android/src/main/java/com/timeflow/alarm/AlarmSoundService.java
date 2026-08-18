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
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

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
    /** 已经通知过 JS "fired" 的 alarmId 集合；service 实例可能被多个不同闹钟复用。 */
    private final Set<String> firedNotifiedAlarmIds = new HashSet<>();
    /**
     * 界面/音频被占用时到达的闹钟排在这里，而不是被 overlayView != null 的检查直接
     * 丢弃——每条闹钟一进 onStartCommand 就已经从持久化列表删除、也通知过 JS
     * "fired"，如果不排队就无声无息地跳过展示，用户永远看不到、也点不到它，
     * disposition 卡在 pending 上再也等不到确认/延后。confirm/snooze 处理完当前
     * 这条后从队首取下一条顶上，队列空了才真正 stopSelf()。
     */
    private final ArrayDeque<AlarmContract.ExtractedExtras> pendingQueue = new ArrayDeque<>();

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        AlarmContract.ExtractedExtras extras = AlarmContract.ExtractedExtras.from(this, intent);

        if (overlayView != null) {
            // 界面被占用：先把这条闹钟从持久化列表摘掉、通知 JS 已经 fired（跟
            // 立刻展示的那条待遇一致，不然 JS 侧的状态跟"其实已经响了"对不上），
            // 排队等前一条处理完再展示，不在这里动 this.alarmId 等字段——那些字段
            // 是当前正在展示的那条的，showAlarmOverlay() 里捕获给 snooze/dismiss
            // lambda 用，这里改了就是重蹈之前"串号"的覆辙。
            AlarmScheduler.removeAlarmRecord(this, extras.alarmId, extras.requestCode);
            if (firedNotifiedAlarmIds.add(extras.alarmId)) {
                AlarmNativeBridge.notifyFired(this, extras.scheduleId, extras.alarmId, extras.title);
            }
            pendingQueue.add(extras);
            return START_NOT_STICKY;
        }

        presentAlarm(extras);
        return START_NOT_STICKY;
    }

    /** 展示某一条闹钟：更新前台通知、摘除持久化记录、通知 JS fired、弹响铃界面。 */
    private void presentAlarm(AlarmContract.ExtractedExtras extras) {
        requestCode = extras.requestCode;
        alarmId = extras.alarmId;
        scheduleId = extras.scheduleId;
        alarmTitle = extras.title;

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
            if (firedNotifiedAlarmIds.add(alarmId)) {
                AlarmNativeBridge.notifyFired(this, scheduleId, alarmId, alarmTitle);
            }
            showAlarmOverlay(alarmTitle);
            if (mediaPlayer == null) {
                startBundledSpeech();
            }
        } catch (RuntimeException exception) {
            advanceOrStop();
        }
    }

    /** 当前这条处理完了：队列里还有就顶上下一条，没有才真正停服务。 */
    private void advanceOrStop() {
        AlarmContract.ExtractedExtras next = pendingQueue.poll();
        if (next == null) {
            stopSelf();
            return;
        }
        presentAlarm(next);
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
        // MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS (API 36) 不能引用：这个模块
        // 的 build.gradle 把 compileSdkVersion 定死在 35，javac 在编译期就解析不到
        // 这个符号，跟运行时的 SDK_INT 判断无关，会直接编译失败。
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

        // 捕获这一刻的 alarmId/scheduleId/title 成局部 final 变量，snooze/dismiss
        // lambda 读这几个变量而不是 this.alarmId 等可变实例字段。presentAlarm()
        // 现在保证同一时刻只有"正在展示"的那条闹钟会改这些字段（排队中的闹钟在
        // pendingQueue 里等着，advanceOrStop() 顶上来才会改字段、重建界面），这里
        // 仍然捕获局部变量是双重保险，不依赖调用方永远遵守这个约定。
        String targetAlarmId = alarmId;
        String targetScheduleId = scheduleId;
        String targetTitle = title;

        View content = AlarmRingUi.build(
                this,
                title,
                view -> {
                    long triggerAt = System.currentTimeMillis()
                            + AlarmContract.SNOOZE_MINUTES * 60_000L;
                    try {
                        AlarmScheduler.schedule(this, triggerAt, targetTitle, targetScheduleId);
                    } catch (RuntimeException ignored) {
                        // ignore
                    }
                    AlarmNativeBridge.notifySnoozed(this, targetScheduleId, targetAlarmId, targetTitle);
                    removeAlarmOverlay();
                    RingActivity.finishIfOpen();
                    advanceOrStop();
                },
                view -> {
                    AlarmNativeBridge.notifyDismissed(this, targetScheduleId, targetAlarmId, targetTitle);
                    removeAlarmOverlay();
                    RingActivity.finishIfOpen();
                    advanceOrStop();
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
