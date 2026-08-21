package com.timeflow.alarm;

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
                .putExtra(
                        AlarmContract.EXTRA_VIBRATE,
                        intent.getBooleanExtra(AlarmContract.EXTRA_VIBRATE, true)
                )
                .putExtra(
                        AlarmContract.EXTRA_SOUND,
                        intent.getBooleanExtra(AlarmContract.EXTRA_SOUND, true)
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
        }
    }
}
