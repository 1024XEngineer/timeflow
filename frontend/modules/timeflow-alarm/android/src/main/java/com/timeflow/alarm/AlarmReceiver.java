package com.timeflow.alarm;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

public final class AlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "AlarmReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        // 临时诊断日志：确认系统广播到底有没有投递到这里。后台完全没反应时，
        // 先看 logcat 有没有这行——没有就说明连 onReceive 都没被调用，问题在
        // AlarmManager 投递之前（大概率是 OEM 进程管理层拦的，不是这段代码的问题）。
        Log.i(TAG, "onReceive action=" + intent.getAction());
        if (!AlarmContract.ACTION_FIRE_ALARM.equals(intent.getAction())) {
            return;
        }

        int requestCode = intent.getIntExtra(AlarmContract.EXTRA_REQUEST_CODE, 0);
        String alarmId = intent.getStringExtra(AlarmContract.EXTRA_ALARM_ID);
        String scheduleId = intent.getStringExtra(AlarmContract.EXTRA_SCHEDULE_ID);
        String title = intent.getStringExtra(AlarmContract.EXTRA_TITLE);
        String speechText = intent.getStringExtra(AlarmContract.EXTRA_SPEECH_TEXT);
        if (alarmId == null || alarmId.isEmpty()) {
            alarmId = "legacy-" + requestCode;
        }
        if (scheduleId == null) {
            scheduleId = "";
        }
        Intent serviceIntent = new Intent(context, AlarmSoundService.class)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, speechText)
                .putExtra(
                        AlarmContract.EXTRA_VIBRATE,
                        intent.getBooleanExtra(AlarmContract.EXTRA_VIBRATE, true)
                )
                .putExtra(
                        AlarmContract.EXTRA_SOUND_TIER,
                        intent.getStringExtra(AlarmContract.EXTRA_SOUND_TIER)
                )
                .putExtra(
                        AlarmContract.EXTRA_FULL_SCREEN,
                        intent.getBooleanExtra(AlarmContract.EXTRA_FULL_SCREEN, true)
                );
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.i(TAG, "startForegroundService requested for alarmId=" + alarmId);
        } catch (RuntimeException exception) {
            // 同样是诊断用：startForegroundService 在部分厂商 ROM/系统版本上会因为
            // 后台启动限制抛异常（比如 ForegroundServiceStartNotAllowedException），
            // 原来这里完全没兜底，抛出去要么被系统吞掉、要么让这条广播直接崩溃退出，
            // 日志里连个痕迹都留不下。
            Log.w(TAG, "startForegroundService failed for alarmId=" + alarmId, exception);
            postFallbackNotification(context, title);
        }
    }

    /**
     * 前台服务起不来时的最后一道兜底：发一条普通通知，不需要 startForegroundService
     * 那一套权限，只要 POST_NOTIFICATIONS 就行——比"什么痕迹都不留"好，哪怕全屏止铃页
     * 和声音/震动都没能展示出来，用户至少能在通知栏看到这条提醒。
     */
    private void postFallbackNotification(Context context, String title) {
        try {
            AlarmContract.ensureChannel(context);
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                return;
            }
            Notification notification = new Notification.Builder(context, AlarmContract.CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle(title == null || title.isEmpty() ? "日程提醒" : title)
                    .setContentText("点击打开 Timeflow 处理")
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setPriority(Notification.PRIORITY_MAX)
                    .setAutoCancel(true)
                    .build();
            manager.notify((int) (System.currentTimeMillis() & 0x7fffffff), notification);
        } catch (RuntimeException ignored) {
            // 尽力而为；这已经是最后一道兜底，失败就真的没办法了。
        }
    }
}
