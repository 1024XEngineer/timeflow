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

        private ExtractedExtras(String alarmId, String scheduleId, String title, int requestCode) {
            this.alarmId = alarmId;
            this.scheduleId = scheduleId;
            this.title = title;
            this.requestCode = requestCode;
        }

        static ExtractedExtras from(Context context, Intent intent) {
            int requestCode = intent == null ? 0 : intent.getIntExtra(EXTRA_REQUEST_CODE, 0);
            String alarmId = intent == null ? null : intent.getStringExtra(EXTRA_ALARM_ID);
            String scheduleId = intent == null ? null : intent.getStringExtra(EXTRA_SCHEDULE_ID);
            String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
            if (alarmId == null || alarmId.isEmpty()) {
                alarmId = "legacy-" + requestCode;
            }
            if (scheduleId == null || scheduleId.isEmpty()) {
                scheduleId = AlarmScheduler.scheduleIdForAlarm(context, alarmId);
            }
            if (title == null || title.isEmpty()) {
                title = "日程提醒";
            }
            return new ExtractedExtras(alarmId, scheduleId, title, requestCode);
        }
    }
}
