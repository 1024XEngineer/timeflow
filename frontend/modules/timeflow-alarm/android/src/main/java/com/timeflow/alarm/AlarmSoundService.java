package com.timeflow.alarm;

import android.app.Notification;
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
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
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
    private static final String TAG = "AlarmSoundService";
    private static final long SPEECH_REPEAT_DELAY_MILLIS = 1_500L;

    private final Handler playbackHandler = new Handler(Looper.getMainLooper());
    private final Runnable replaySpeech = this::replaySpeech;
    private final Runnable replayTts = this::replayTts;

    private MediaPlayer mediaPlayer;
    private Ringtone pingRingtone;
    private boolean destroyed;
    private File bundledSpeechFile;
    private WindowManager overlayWindowManager;
    /** 包内可见（而非 private）：AlarmSoundServiceTest 需要直接读取当前展示/排队状态。 */
    View overlayView;
    String alarmId;
    String scheduleId;
    String alarmTitle;
    private boolean vibrateEnabled;
    private String soundTier;
    private boolean fullScreenEnabled;
    private int requestCode;
    /** 当前这条闹钟的设备 TTS 文案；非 high 或未传入时为 null/空，走打包铃。 */
    private String speechText;
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
    public void onCreate() {
        super.onCreate();
        initTextToSpeech();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        AlarmContract.ExtractedExtras extras = AlarmContract.ExtractedExtras.from(this, intent);
        // 临时诊断日志：确认 AlarmReceiver 拉起的 startForegroundService 有没有真的
        // 走到这里——如果 AlarmReceiver 那边"startForegroundService requested"打出来了
        // 但这里没打印，说明系统在投递 Intent 给这个 Service 之前就把它拦下来了。
        Log.i(TAG, "onStartCommand alarmId=" + extras.alarmId + " scheduleId=" + extras.scheduleId
                + " vibrate=" + extras.vibrate + " soundTier=" + extras.soundTier
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
            postQueuedNotification(extras);
            // 排队顶不上全屏页，但 postQueuedNotification() 确实发出了一条用户可见的
            // 普通通知——对 presentNow() 的调用方来说，这不算"什么都没展示"。
            AlarmModule.resolvePresentation(extras.alarmId, true);
            return START_NOT_STICKY;
        }

        presentAlarm(extras);
        return START_NOT_STICKY;
    }

    /**
     * 前一条止铃页还没关掉、这条闹钟被排进队列时的兜底：发一条普通通知，不然这条
     * 闹钟在真正顶上来之前完全没有任何用户可见的痕迹——用户只会在"点开 App 才发现
     * 还有一条没处理"的时候才后知后觉，跟没提醒过没什么区别。
     */
    private void postQueuedNotification(AlarmContract.ExtractedExtras extras) {
        try {
            AlarmContract.ensureChannel(this);
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                return;
            }
            Notification notification = new Notification.Builder(this, AlarmContract.CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle(extras.title)
                    .setContentText("还有一条提醒排队中，点击打开 Timeflow 处理")
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setPriority(Notification.PRIORITY_MAX)
                    .setAutoCancel(true)
                    .build();
            manager.notify(extras.requestCode, notification);
        } catch (RuntimeException ignored) {
            // 尽力而为，失败也不能挡住排队本身。
        }
    }

    /** 展示某一条闹钟：更新前台通知、摘除持久化记录、通知 JS fired、弹响铃界面。 */
    private void presentAlarm(AlarmContract.ExtractedExtras extras) {
        requestCode = extras.requestCode;
        alarmId = extras.alarmId;
        scheduleId = extras.scheduleId;
        alarmTitle = extras.title;
        vibrateEnabled = extras.vibrate;
        soundTier = extras.soundTier;
        fullScreenEnabled = extras.fullScreen;
        speechText = extras.speechText;
        // 诊断用：这条闹钟真正展示的这一刻，soundTier/speechText/TTS 引擎状态到底是
        // 什么——如果 wantsSpeech()=false 或引擎没就绪，就是这两个原因之一让它
        // 退回了打包铃。定位问题排查完可以删。
        Log.i(TAG, "presentAlarm speech diagnostics alarmId=" + alarmId
                + " soundTier=" + soundTier
                + " speechText=" + speechText
                + " wantsSpeech=" + wantsSpeech()
                + " ttsReady=" + AlarmTtsEngine.isReady());

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
            // startForeground() 已经成功——至少那条前台通知确实发出去了，对
            // presentNow() 的调用方来说这就算"展示了"，不用等下面全屏页/悬浮窗的
            // 结果（那两条本来就没有系统回调能确认真的被用户看到）。
            AlarmModule.resolvePresentation(alarmId, true);
            // 换成下一条闹钟之前先清掉上一条的震动/声音状态，避免上一条闹钟启动的
            // 那次播放/震动残留到这条本该更安静的闹钟上。
            stopVibration();
            stopPing();
            releaseMediaPlayer();
            stopSpeaking();
            if (vibrateEnabled) {
                startVibration();
            }
            if (fullScreenEnabled) {
                showAlarmOverlay(alarmTitle);
            }
            if (AlarmContract.SOUND_TIER_FULL.equals(soundTier) && mediaPlayer == null) {
                if (wantsSpeech() && AlarmTtsEngine.isReady()) {
                    speakCurrent();
                } else {
                    // 引擎是 AlarmModule 构造时就抢先绑定的全局单例，真响铃这一刻通常早就
                    // 绑定好了；万一还没好（比如冷启动竞态），先响打包铃保底，
                    // notifyWhenReady() 排一个回调，绑定成功那一刻无缝切到 TTS。
                    startBundledSpeech();
                    if (wantsSpeech()) {
                        AlarmTtsEngine.notifyWhenReady(this::maybeSwitchToSpeech);
                    }
                }
            } else if (AlarmContract.SOUND_TIER_PING.equals(soundTier)) {
                startPing();
            }
        } catch (RuntimeException exception) {
            // 这里原来完全静默——startForeground() 在部分厂商 ROM/系统版本上会因为
            // 后台启动限制抛异常（比如 ForegroundServiceStartNotAllowedException），
            // 抛出去之前这条闹钟就已经从持久化列表摘掉、也通知过 JS "fired" 了，一旦
            // 走到这个 catch，整条链路就是"通知也没弹、声音也没放、震动也没震"，
            // 跟用户看到的现象完全对得上，但之前没有任何日志能证实。
            Log.w(TAG, "presentAlarm failed for alarmId=" + alarmId, exception);
            // 真的什么都没展示：之前这里完全没告诉 presentNow() 的调用方，JS 侧会把
            // 服务启动请求本身当成"已展示"，跳过通知兜底——用户彻底看不到任何东西。
            AlarmModule.resolvePresentation(alarmId, false);
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
        releaseMediaPlayer();
        // 只停这个 Service 实例正在念的这一句、摘掉它挂上去的监听器——引擎是全局单例，
        // 不在这里 shutdown()：下一条闹钟（甚至冷启动重新拉起这个 Service）还要复用。
        AlarmTtsEngine.stop();
        AlarmTtsEngine.setUtteranceListener(null);
        stopVibration();
        stopPing();
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
            String title,
            boolean vibrate,
            String soundTier,
            boolean fullScreen,
            String speechText
    ) {
        Intent intent = new Intent(context, AlarmSoundService.class)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title)
                .putExtra(AlarmContract.EXTRA_VIBRATE, vibrate)
                .putExtra(AlarmContract.EXTRA_SOUND_TIER, soundTier)
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
                .putExtra(AlarmContract.EXTRA_VIBRATE, vibrateEnabled)
                .putExtra(AlarmContract.EXTRA_SOUND_TIER, soundTier)
                .putExtra(AlarmContract.EXTRA_FULL_SCREEN, fullScreen)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, speechText)
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
        AlarmContract.ensureChannel(this);
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
        boolean targetVibrate = vibrateEnabled;
        String targetSoundTier = soundTier;
        boolean targetFullScreen = fullScreenEnabled;
        String targetSpeechText = speechText;

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
                                targetSoundTier,
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

    /**
     * 设备 TTS 是 best-effort：不可用就走打包铃，绝不重试到崩。引擎本身是
     * AlarmTtsEngine 持有的全局单例、在 AlarmModule 构造时就已经抢先绑定过
     * （见该类顶部注释）——这里只是兜底再确认一次已经启动过初始化，真正的
     * 绑定/初始化逻辑不在这个 Service 里。
     */
    private void initTextToSpeech() {
        AlarmTtsEngine.ensureInitialized(this);
    }

    /** 当前这条是否该念 TTS：high 档位且有非空文案。 */
    private boolean wantsSpeech() {
        return AlarmContract.SOUND_TIER_FULL.equals(soundTier)
                && speechText != null && !speechText.trim().isEmpty();
    }

    private final UtteranceProgressListener utteranceListener = new UtteranceProgressListener() {
        @Override
        public void onStart(String utteranceId) {
            // 无需处理。
        }

        @Override
        public void onDone(String utteranceId) {
            playbackHandler.postDelayed(replayTts, SPEECH_REPEAT_DELAY_MILLIS);
        }

        @Override
        public void onError(String utteranceId) {
            onSpeechError();
        }
    };

    private void speakCurrent() {
        if (destroyed || !AlarmTtsEngine.isReady() || !wantsSpeech()) {
            Log.i(TAG, "speakCurrent bailed destroyed=" + destroyed
                    + " ttsReady=" + AlarmTtsEngine.isReady()
                    + " wantsSpeech=" + wantsSpeech());
            return;
        }
        AlarmTtsEngine.setUtteranceListener(utteranceListener);
        // speak() 的返回值只代表"这句话有没有成功排进播放队列"，不代表真的念出来了——
        // 但如果连排队都失败（返回 ERROR），后面大概率也不会有 onDone/onError 回调，
        // 之前完全没有日志能看出这一步失败过。定位问题排查完可以删。
        int result = AlarmTtsEngine.speak(speechText, "reminder-high");
        Log.i(TAG, "speakCurrent queued text=" + speechText + " result=" + result);
    }

    private void replayTts() {
        if (destroyed) {
            return;
        }
        speakCurrent();
    }

    /** 引擎就绪后，若这条闹钟还在打包铃保底、且确实该念 TTS，就切过去。 */
    private void maybeSwitchToSpeech() {
        if (destroyed || !AlarmTtsEngine.isReady() || !wantsSpeech()) {
            Log.i(TAG, "maybeSwitchToSpeech skipped destroyed=" + destroyed
                    + " ttsReady=" + AlarmTtsEngine.isReady()
                    + " wantsSpeech=" + wantsSpeech());
            return;
        }
        releaseMediaPlayer();
        speakCurrent();
    }

    /** TTS 合成失败：清掉重念回调，退回打包铃继续保底。 */
    private void onSpeechError() {
        Log.w(TAG, "TextToSpeech onError alarmId=" + alarmId);
        playbackHandler.post(() -> {
            if (destroyed || !wantsSpeech()) {
                return;
            }
            playbackHandler.removeCallbacks(replayTts);
            if (mediaPlayer == null) {
                startBundledSpeech();
            }
        });
    }

    /** 停掉当前这条在念的 TTS，但不销毁引擎——引擎是全局单例，换下一条闹钟/下次
     * 冷启动都要复用同一个已经绑定好的实例。 */
    private void stopSpeaking() {
        playbackHandler.removeCallbacks(replayTts);
        AlarmTtsEngine.stop();
    }

    private void removeFromSavedAlarms() {
        AlarmScheduler.removeAlarmRecord(this, alarmId, requestCode);
    }

    /**
     * 低/中强度用的一次性短提示音：直接用系统默认通知铃声播一遍就停，不循环、
     * 不需要额外打包音频素材——跟高强度那段循环语音（startBundledSpeech()）是
     * 两套独立的播放器实例，互不干扰，也不共用同一个 MediaPlayer。
     */
    private void startPing() {
        if (destroyed) {
            return;
        }
        try {
            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (soundUri == null) {
                return;
            }
            Ringtone ringtone = RingtoneManager.getRingtone(this, soundUri);
            if (ringtone == null) {
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
            }
            pingRingtone = ringtone;
            ringtone.play();
        } catch (RuntimeException ignored) {
            // 尽力播放一声提示音；拿不到系统默认铃声就静默跳过，不影响震动/全屏。
        }
    }

    private void stopPing() {
        if (pingRingtone != null) {
            try {
                pingRingtone.stop();
            } catch (RuntimeException ignored) {
                // 忽略停止失败。
            }
            pingRingtone = null;
        }
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
