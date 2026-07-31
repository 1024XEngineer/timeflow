package com.timeflow.alarm;

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
    private String alarmTitle;
    private int requestCode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        currentActivity = new WeakReference<>(this);
        requestCode = getIntent().getIntExtra(AlarmContract.EXTRA_REQUEST_CODE, 0);
        alarmId = getIntent().getStringExtra(AlarmContract.EXTRA_ALARM_ID);
        alarmTitle = getIntent().getStringExtra(AlarmContract.EXTRA_TITLE);
        if (alarmId == null || alarmId.isEmpty()) {
            alarmId = "legacy-" + requestCode;
        }
        if (alarmTitle == null || alarmTitle.isEmpty()) {
            alarmTitle = "日程提醒";
        }
        makeVisibleOverLockScreen();
        matchSystemBarsToReminder();
        setContentView(buildContentView());
        removeFromSavedAlarms();
        AlarmSoundService.start(
                this,
                alarmId,
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

    private View buildContentView() {
        return AlarmRingUi.build(this, alarmTitle, view -> stopAndClose());
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
     * The reminder is a light surface, so the system bars have to carry dark icons —
     * a device in dark mode would otherwise draw white icons onto near-white.
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

    private void stopAndClose() {
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
        stopAndClose();
    }

}
