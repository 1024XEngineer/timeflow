package com.timeflow.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 重新挂上系统重启 / 应用更新后被清空的 AlarmManager 注册。
 * MY_PACKAGE_REPLACED 覆盖应用更新场景——同样会清空 AlarmManager，行为跟重启一致。
 */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        AlarmScheduler.rescheduleAfterBoot(context);
    }
}
