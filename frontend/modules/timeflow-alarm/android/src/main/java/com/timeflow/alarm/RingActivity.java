package com.timeflow.alarm;

import android.app.ActivityOptions;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import java.lang.ref.WeakReference;

public final class RingActivity extends Activity {
    private static WeakReference<RingActivity> currentActivity = new WeakReference<>(null);

    private String alarmId;
    private String scheduleId;
    private String alarmTitle;
    private int requestCode;
    private boolean dismissNotified;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        currentActivity = new WeakReference<>(this);
        AlarmContract.ExtractedExtras extras = AlarmContract.ExtractedExtras.from(this, getIntent());
        requestCode = extras.requestCode;
        alarmId = extras.alarmId;
        scheduleId = extras.scheduleId;
        alarmTitle = extras.title;
        setContentView(buildContentView());
        makeVisibleOverLockScreen();
        matchSystemBarsToReminder();
        removeFromSavedAlarms();
        AlarmSoundService.start(
                this,
                alarmId,
                scheduleId,
                requestCode,
                alarmTitle
        );
    }

    @Override
    protected void onDestroy() {
        if (currentActivity.get() == this) {
            currentActivity.clear();
        }
        super.onDestroy();
    }

    static void finishIfOpen() {
        RingActivity activity = currentActivity.get();
        if (activity != null && !activity.isFinishing()) {
            activity.finishAndRemoveTask();
        }
    }

    static boolean isShowing() {
        RingActivity activity = currentActivity.get();
        return activity != null && !activity.isFinishing();
    }

    /**
     * 悬浮窗不可用时（权限未授 / OEM 拦截）由 AlarmSoundService 主动拉起的兜底宿主。
     * 已经在展示就不再重复启动，避免多重叠 UI。
     * <p>
     * 不能直接 context.startActivity()：Android 10+ 的后台 Activity 启动限制（BAL）会
     * 拦截从"无可见窗口的前台服务"启动 Activity（实测 Android 16 上直接 startActivity
     * 抛 result code=102 BAL_BLOCK）。必须像 buildNotification 的 fullScreenIntent 一样，
     * 给 PendingIntent 带上创建者豁免（MODE_BACKGROUND_ACTIVITY_START_ALLOWED）再 send。
     */
    static void launch(Context context, String alarmId, String scheduleId, int requestCode, String title) {
        if (isShowing()) {
            return;
        }
        Intent intent = new Intent(context, RingActivity.class)
                .setData(AlarmScheduler.alarmUri(alarmId))
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pending = PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE,
                pendingIntentOptions()
        );
        try {
            pending.send();
        } catch (PendingIntent.CanceledException ignored) {
            // 极少发生：pending 刚被取消。悬浮层若仍在，用户仍能看到自定义 UI。
        }
    }

    private static Bundle pendingIntentOptions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return null;
        }
        ActivityOptions options = ActivityOptions.makeBasic();
        options.setPendingIntentCreatorBackgroundActivityStartMode(
                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
        );
        return options.toBundle();
    }

    private View buildContentView() {
        return AlarmRingUi.build(
                this,
                alarmTitle,
                view -> snoozeAndClose(),
                view -> confirmAndClose()
        );
    }

    private void makeVisibleOverLockScreen() {
        Window window = getWindow();
        window.addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                        | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }

    /**
     * 提醒界面偏浅色，系统栏需使用深色图标；
     * 否则深色模式下浅底上会出现白色图标。
     */
    private void matchSystemBarsToReminder() {
        Window window = getWindow();
        window.setStatusBarColor(AlarmRingUi.topEdgeColor());
        window.setNavigationBarColor(AlarmRingUi.bottomEdgeColor());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
            return;
        }
        window.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                        | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        );
    }

    private void confirmAndClose() {
        if (!dismissNotified) {
            dismissNotified = true;
            AlarmNativeBridge.notifyDismissed(this, scheduleId, alarmId, alarmTitle);
        }
        AlarmSoundService.stop(this);
        cancelNotification();
        cancelAlarmPendingIntent();
        finishAndRemoveTask();
    }

    private void snoozeAndClose() {
        if (!dismissNotified) {
            dismissNotified = true;
            long triggerAt = System.currentTimeMillis()
                    + AlarmContract.SNOOZE_MINUTES * 60_000L;
            try {
                AlarmScheduler.schedule(this, triggerAt, alarmTitle, scheduleId);
            } catch (RuntimeException ignored) {
                // 尽力重新挂闹钟；即使失败也通知 JS 落 snooze 状态。
            }
            AlarmNativeBridge.notifySnoozed(this, scheduleId, alarmId, alarmTitle);
        }
        AlarmSoundService.stop(this);
        cancelNotification();
        cancelAlarmPendingIntent();
        finishAndRemoveTask();
    }

    private void cancelNotification() {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(requestCode);
        }
    }

    private void cancelAlarmPendingIntent() {
        AlarmManager alarmManager = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return;
        }

        Intent activityIntent = new Intent(this, RingActivity.class)
                .setData(alarmUri(alarmId));
        PendingIntent activityPendingIntent = PendingIntent.getActivity(
                this,
                requestCode,
                activityIntent,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
        );
        Intent broadcastIntent = new Intent(this, AlarmReceiver.class)
                .setAction(AlarmContract.ACTION_FIRE_ALARM);
        if (!isLegacyAlarm()) {
            broadcastIntent.setData(alarmUri(alarmId));
        }
        PendingIntent broadcastPendingIntent = PendingIntent.getBroadcast(
                this,
                requestCode,
                broadcastIntent,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
        );
        if (activityPendingIntent != null) {
            alarmManager.cancel(activityPendingIntent);
            activityPendingIntent.cancel();
        }
        if (broadcastPendingIntent != null) {
            alarmManager.cancel(broadcastPendingIntent);
            broadcastPendingIntent.cancel();
        }
    }

    private Uri alarmUri(String value) {
        return AlarmScheduler.alarmUri(value);
    }

    private boolean isLegacyAlarm() {
        return alarmId != null && alarmId.startsWith("legacy-");
    }

    private void removeFromSavedAlarms() {
        AlarmScheduler.removeAlarmRecord(this, alarmId, requestCode);
    }


    @Override
    public void onBackPressed() {
        confirmAndClose();
    }

}
