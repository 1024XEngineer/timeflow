package com.timeflow.alarm;

import android.content.Context;
import android.content.Intent;

final class AlarmContract {
    static final String ACTION_FIRE_ALARM = "com.timeflow.FIRE_ALARM";
    static final String ACTION_ALARM_EVENT = "com.timeflow.ALARM_EVENT";
    static final String EXTRA_ALARM_ID = "alarm_id";
    static final String EXTRA_REQUEST_CODE = "request_code";
    static final String EXTRA_TITLE = "alarm_title";
    static final String EXTRA_SCHEDULE_ID = "schedule_id";
    /** 响铃要不要震动/出声/弹全屏止铃界面；由 JS 侧按提醒强度换算后传入，缺省一律按 true 处理。 */
    static final String EXTRA_VIBRATE = "vibrate";
    static final String EXTRA_SOUND = "sound";
    static final String EXTRA_FULL_SCREEN = "full_screen";
    static final String EXTRA_EVENT_TYPE = "event_type";
    static final String EVENT_FIRED = "fired";
    static final String EVENT_DISMISSED = "dismissed";
    static final String EVENT_SNOOZED = "snoozed";
    /** 与 JS DEFAULT_SNOOZE_MINUTES 对齐。 */
    static final long SNOOZE_MINUTES = 10L;
    static final String CHANNEL_ID = "timeflow_alarm_channel_v1";
    static final String PREFS_NAME = "timeflow_alarms";
    static final String ALARMS_KEY = "pending_alarms";
    static final String DISPOSITIONS_KEY = "native_dispositions";
    static final String ALARM_URI_SCHEME = "timeflow-alarm";
    /**
     * 自启动/后台弹出界面没有标准 API 能查真实授权状态，这三个 key 只记录
     * "带没带用户跳过设置页"和"上一次响铃悬浮窗有没有失败"这种弱信号。
     */
    static final String KEY_OEM_AUTOSTART_GUIDED = "oem_autostart_guided";
    static final String KEY_OEM_BACKGROUND_POPUP_GUIDED = "oem_background_popup_guided";
    static final String KEY_OEM_LAST_OVERLAY_FAILED = "oem_last_overlay_failed";

    private AlarmContract() {
    }

    /**
     * AlarmSoundService 和 RingActivity 都要从触发 Intent 里读同一组字段、
     * 补同样的 legacy id / scheduleId 反查 / 默认标题——抽在这里，避免两边分别写、
     * 以后改默认值或反查逻辑时漏改一处。
     */
    static final class ExtractedExtras {
        final String alarmId;
        final String scheduleId;
        final String title;
        final int requestCode;
        final boolean vibrate;
        final boolean sound;
        final boolean fullScreen;

        private ExtractedExtras(
                String alarmId,
                String scheduleId,
                String title,
                int requestCode,
                boolean vibrate,
                boolean sound,
                boolean fullScreen
        ) {
            this.alarmId = alarmId;
            this.scheduleId = scheduleId;
            this.title = title;
            this.requestCode = requestCode;
            this.vibrate = vibrate;
            this.sound = sound;
            this.fullScreen = fullScreen;
        }

        static ExtractedExtras from(Context context, Intent intent) {
            int requestCode = intent == null ? 0 : intent.getIntExtra(EXTRA_REQUEST_CODE, 0);
            String alarmId = intent == null ? null : intent.getStringExtra(EXTRA_ALARM_ID);
            String scheduleId = intent == null ? null : intent.getStringExtra(EXTRA_SCHEDULE_ID);
            String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
            // 缺省按 true：兼容没有带这几个 extra 的旧闹钟/测试 Intent，保留改动前的全响铃行为。
            boolean vibrate = intent == null || intent.getBooleanExtra(EXTRA_VIBRATE, true);
            boolean sound = intent == null || intent.getBooleanExtra(EXTRA_SOUND, true);
            boolean fullScreen = intent == null || intent.getBooleanExtra(EXTRA_FULL_SCREEN, true);
            if (alarmId == null || alarmId.isEmpty()) {
                alarmId = "legacy-" + requestCode;
            }
            if (scheduleId == null || scheduleId.isEmpty()) {
                scheduleId = AlarmScheduler.scheduleIdForAlarm(context, alarmId);
            }
            if (title == null || title.isEmpty()) {
                title = "日程提醒";
            }
            return new ExtractedExtras(
                    alarmId, scheduleId, title, requestCode, vibrate, sound, fullScreen
            );
        }
    }
}
