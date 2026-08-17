package com.timeflow.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
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
                .putExtra(AlarmContract.EXTRA_TITLE, title);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent);
        } else {
            context.startService(serviceIntent);
        }
    }
}
