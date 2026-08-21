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
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

public final class AlarmSoundService extends Service {
    private static final String TAG = "AlarmSoundService";
    private static final long SPEECH_REPEAT_DELAY_MILLIS = 1_500L;
    private static final float TTS_SPEECH_RATE = 0.9f;
    private static final float TTS_PITCH = 1.0f;

    private final Handler playbackHandler = new Handler(Looper.getMainLooper());
    private final Runnable replaySpeech = this::scheduleTtsReplay;

    private TextToSpeech textToSpeech;
    private boolean ttsReady;
    private int ttsGeneration;
    private boolean destroyed;
    private String currentSpeechText;
    private String currentUtteranceId;
    private WindowManager overlayWindowManager;
    /** 包内可见（而非 private）：AlarmSoundServiceTest 需要直接读取当前展示/排队状态。 */
    View overlayView;
    String alarmId;
    String scheduleId;
    String alarmTitle;
    private boolean vibrateEnabled;
    private boolean soundEnabled;
    private boolean fullScreenEnabled;
    private int requestCode;
    /** 已经通知过 JS "fired" 的 alarmId 集合；service 实例可能被多个不同闹钟复用。 */
    final Set<String> firedNotifiedAlarmIds = new HashSet<>();
    /**
     * 界面/音频被占用时到达的闹钟排在这里，而不是被 overlayView != null 的检查直接
     * 丢弃——每条闹钟一进 onStartCommand 就已经从持久化列表删除、也通知过 JS
     * "fired"，如果不排队就无声无息地跳过展示，用户永远看不到、也点不到它，
     * disposition 卡在 pending 上再也等不到确认/延后。confirm/snooze 处理完当前
     * 这条后从队首取下一条顶上，队列空了才真正 stopSelf()。
     */
    final ArrayDeque<AlarmContract.ExtractedExtras> pendingQueue = new ArrayDeque<>();

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        AlarmContract.ExtractedExtras extras = AlarmContract.ExtractedExtras.from(this, intent);
        // 临时诊断日志：确认 AlarmReceiver 拉起的 startForegroundService 有没有真的
        // 走到这里——如果 AlarmReceiver 那边"startForegroundService requested"打出来了
        // 但这里没打印，说明系统在投递 Intent 给这个 Service 之前就把它拦下来了。
        Log.i(TAG, "onStartCommand alarmId=" + extras.alarmId + " scheduleId=" + extras.scheduleId
                + " vibrate=" + extras.vibrate + " sound=" + extras.sound
                + " fullScreen=" + extras.fullScreen);

        if (overlayView != null) {
            // 临时诊断日志：这行打出来就说明这条闹钟被前一条还没关掉的止铃界面
            // 卡住了，静默进了队列，不会有任何全屏/声音/震动——不是这条闹钟本身
            // 有问题，是前一条 alarmId 没被确认/延后/关闭。
            Log.i(TAG, "onStartCommand alarmId=" + extras.alarmId
                    + " queued behind currently visible alarmId=" + alarmId);
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
        currentSpeechText = extras.speechText;
        vibrateEnabled = extras.vibrate;
        soundEnabled = extras.sound;
        fullScreenEnabled = extras.fullScreen;

        createNotificationChannel();
        Notification notification = buildNotification(alarmId, alarmTitle, fullScreenEnabled);
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
            // 换成下一条闹钟前先清掉上一条的声音/震动状态，避免静音或不震动的
            // 新闹钟继续沿用前一条已经启动的系统资源。
            shutdownTts();
            stopVibration();
            if (vibrateEnabled) {
                startVibration();
            }
            if (fullScreenEnabled) {
                showAlarmOverlay(alarmTitle);
            }
            if (soundEnabled) {
                initTtsAndSpeak();
            }
        } catch (RuntimeException exception) {
            // 这里原来完全静默——startForeground() 在部分厂商 ROM/系统版本上会因为
            // 后台启动限制抛异常（比如 ForegroundServiceStartNotAllowedException），
            // 抛出去之前这条闹钟就已经从持久化列表摘掉、也通知过 JS "fired" 了，一旦
            // 走到这个 catch，整条链路就是"通知也没弹、声音也没放、震动也没震"，
            // 跟用户看到的现象完全对得上，但之前没有任何日志能证实。
            Log.w(TAG, "presentAlarm failed for alarmId=" + alarmId, exception);
            advanceOrStop();
        }
    }

    /**
     * 当前这条处理完了：队列里还有就顶上下一条，没有才真正停服务。
     * 包内可见（而非 private）：AlarmSoundServiceTest 直接调用来模拟"用户处理完当前这条"，
     * 不经过真实悬浮窗按钮点击链路。
     */
    void advanceOrStop() {
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
        shutdownTts();
        stopVibration();
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
            String title,
            boolean vibrate,
            boolean sound,
            boolean fullScreen,
            String speechText
    ) {
        Intent intent = new Intent(context, AlarmSoundService.class)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title)
                .putExtra(AlarmContract.EXTRA_VIBRATE, vibrate)
                .putExtra(AlarmContract.EXTRA_SOUND, sound)
                .putExtra(AlarmContract.EXTRA_FULL_SCREEN, fullScreen)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, speechText);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    private Notification buildNotification(String alarmId, String title, boolean fullScreen) {
        Intent ringIntent = new Intent(this, RingActivity.class)
                .setData(alarmUri(alarmId))
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, currentSpeechText)
                .putExtra(AlarmContract.EXTRA_VIBRATE, vibrateEnabled)
                .putExtra(AlarmContract.EXTRA_SOUND, soundEnabled)
                .putExtra(AlarmContract.EXTRA_FULL_SCREEN, fullScreen)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_MULTIPLE_TASK
                        | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        PendingIntent ringPendingIntent = PendingIntent.getActivity(
                this,
                requestCode,
                ringIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE,
                pendingIntentOptions()
        );
        Notification.Builder builder = new Notification.Builder(this, AlarmContract.CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(title)
                .setContentText("点击停止提醒")
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setPriority(Notification.PRIORITY_MAX)
                .setOngoing(true)
                .setAutoCancel(false)
                // 弱强度也要能点通知手动打开止铃界面，只是不强制弹出。
                .setContentIntent(ringPendingIntent);
        if (fullScreen) {
            builder.setFullScreenIntent(ringPendingIntent, true);
        }
        return builder.build();
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
        // 震动改成 startVibration()/stopVibration() 手动控制，好按 vibrateEnabled 逐条开关；
        // 渠道级震动创建后改不了，留 true 就没法让某条闹钟不震。
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void showAlarmOverlay(String title) {
        if (overlayView != null
                || Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || !Settings.canDrawOverlays(this)) {
            // 临时诊断日志：这三个早退条件原来完全静默——尤其是 canDrawOverlays()
            // 为 false 这种情况，之前唯一的失败日志只覆盖 addView() 抛异常那条
            // 分支，根本走不到那里就已经 return 了，logcat 里什么痕迹都没有。
            Log.i(TAG, "showAlarmOverlay skipped: overlayView!=null=" + (overlayView != null)
                    + " canDrawOverlays=" + Settings.canDrawOverlays(this));
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
        String targetSpeechText = currentSpeechText;
        boolean targetVibrate = vibrateEnabled;
        boolean targetSound = soundEnabled;
        boolean targetFullScreen = fullScreenEnabled;

        View content = AlarmRingUi.build(
                this,
                title,
                view -> {
                    long triggerAt = System.currentTimeMillis()
                            + AlarmContract.SNOOZE_MINUTES * 60_000L;
                    try {
                        AlarmScheduler.schedule(
                                this,
                                triggerAt,
                                targetTitle,
                                targetScheduleId,
                                targetVibrate,
                                targetSound,
                                targetFullScreen,
                                targetSpeechText
                        );
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
            OemPermissionHelper.recordOverlayFailure(this, false);
            Log.i(TAG, "showAlarmOverlay addView succeeded for alarmId=" + targetAlarmId);
        } catch (RuntimeException exception) {
            // 常见于小米"后台弹出界面"关闭、或自启动被拦导致系统对这次前台状态判定
            // 不认账——标准悬浮窗权限（上面 canDrawOverlays 那道早退）已经通过了，
            // 这里失败往往是 OEM 私有权限层的问题，留痕给权限页参考。
            Log.w(TAG, "showAlarmOverlay addView failed", exception);
            OemPermissionHelper.recordOverlayFailure(this, true);
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

    /** 初始化系统 TTS，优先使用简体中文，不可用时回退到系统默认语言。 */
    private void initTtsAndSpeak() {
        if (destroyed || !soundEnabled || currentSpeechText == null) {
            return;
        }

        int generation = ++ttsGeneration;
        textToSpeech = new TextToSpeech(this, status -> {
            if (destroyed || generation != ttsGeneration || textToSpeech == null) {
                return;
            }
            if (status != TextToSpeech.SUCCESS) {
                Log.w(TAG, "TTS init failed with status: " + status);
                shutdownTts();
                return;
            }

            int languageResult = textToSpeech.setLanguage(Locale.SIMPLIFIED_CHINESE);
            if (languageResult == TextToSpeech.LANG_MISSING_DATA
                    || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                textToSpeech.setLanguage(Locale.getDefault());
            }
            textToSpeech.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            textToSpeech.setSpeechRate(TTS_SPEECH_RATE);
            textToSpeech.setPitch(TTS_PITCH);
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                }

                @Override
                public void onDone(String utteranceId) {
                    if (!destroyed
                            && soundEnabled
                            && generation == ttsGeneration
                            && utteranceId.equals(currentUtteranceId)) {
                        playbackHandler.postDelayed(replaySpeech, SPEECH_REPEAT_DELAY_MILLIS);
                    }
                }

                @Override
                public void onError(String utteranceId) {
                    // 当前轮播报失败时停止循环，等待用户处理该提醒。
                }
            });
            ttsReady = true;
            speakCurrentText();
        });
    }

    private void speakCurrentText() {
        if (!ttsReady
                || textToSpeech == null
                || destroyed
                || !soundEnabled
                || currentSpeechText == null) {
            return;
        }

        currentUtteranceId = "alarm_" + UUID.randomUUID();
        Bundle params = new Bundle();
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, android.media.AudioManager.STREAM_ALARM);
        int result = textToSpeech.speak(
                currentSpeechText,
                TextToSpeech.QUEUE_FLUSH,
                params,
                currentUtteranceId
        );
        if (result == TextToSpeech.ERROR) {
            Log.w(TAG, "TTS speak failed");
            shutdownTts();
        }
    }

    private void scheduleTtsReplay() {
        if (!destroyed && soundEnabled && currentSpeechText != null) {
            speakCurrentText();
        }
    }

    private void shutdownTts() {
        ttsGeneration += 1;
        playbackHandler.removeCallbacks(replaySpeech);
        TextToSpeech tts = textToSpeech;
        textToSpeech = null;
        ttsReady = false;
        currentUtteranceId = null;
        if (tts == null) {
            return;
        }
        try {
            tts.stop();
            tts.shutdown();
        } catch (RuntimeException ignored) {
            // 系统 TTS 进程可能已退出；停铃仍继续释放其余资源。
        }
    }

    private void removeFromSavedAlarms() {
        AlarmScheduler.removeAlarmRecord(this, alarmId, requestCode);
    }

    /** 震动 / 间隔（毫秒），跟 JS 侧 ReactNativeVibration 的 REPEAT_PATTERN 保持一致。 */
    private static final long[] VIBRATION_PATTERN = {0L, 700L, 350L, 700L};

    private void startVibration() {
        Vibrator vibrator = obtainVibrator();
        if (vibrator == null || !vibrator.hasVibrator()) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0));
        } else {
            vibrator.vibrate(VIBRATION_PATTERN, 0);
        }
    }

    private void stopVibration() {
        Vibrator vibrator = obtainVibrator();
        if (vibrator != null) {
            vibrator.cancel();
        }
    }

    private Vibrator obtainVibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager =
                    (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return manager == null ? null : manager.getDefaultVibrator();
        }
        return (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
    }

}
