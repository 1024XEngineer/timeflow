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
    static final String EXTRA_SPEECH_TEXT = "speech_text";
    static final String EXTRA_EVENT_TYPE = "event_type";
    static final String EVENT_FIRED = "fired";
    static final String EVENT_DISMISSED = "dismissed";
    static final String EVENT_SNOOZED = "snoozed";
    /** 与 JS DEFAULT_SNOOZE_MINUTES 对齐。 */
    static final long SNOOZE_MINUTES = 10L;
    /**
     * 前台服务常驻通知的频道。旧版用 IMPORTANCE_HIGH + fullScreenIntent，亮屏时
     * 一定会弹出系统 heads-up——用户看到的就是"系统弹窗"。响铃提醒只该由自定义
     * 悬浮层 / RingActivity 负责，这个频道改成低调静默，只占通知栏一席不打扰。
     */
    static final String FG_CHANNEL_ID = "timeflow_alarm_fg_channel_v1";
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
        final String speechText;
        final int requestCode;

        private ExtractedExtras(String alarmId, String scheduleId, String title, String speechText, int requestCode) {
            this.alarmId = alarmId;
            this.scheduleId = scheduleId;
            this.title = title;
            this.speechText = speechText;
            this.requestCode = requestCode;
        }

        static ExtractedExtras from(Context context, Intent intent) {
            int requestCode = intent == null ? 0 : intent.getIntExtra(EXTRA_REQUEST_CODE, 0);
            String alarmId = intent == null ? null : intent.getStringExtra(EXTRA_ALARM_ID);
            String scheduleId = intent == null ? null : intent.getStringExtra(EXTRA_SCHEDULE_ID);
            String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
            String speechText = intent == null ? null : intent.getStringExtra(EXTRA_SPEECH_TEXT);
            if (alarmId == null || alarmId.isEmpty()) {
                alarmId = "legacy-" + requestCode;
            }
            if (scheduleId == null || scheduleId.isEmpty()) {
                scheduleId = AlarmScheduler.scheduleIdForAlarm(context, alarmId);
            }
            if (title == null || title.isEmpty()) {
                title = "日程提醒";
            }
            if (speechText == null || speechText.isEmpty()) {
                speechText = ReminderSpeechFormatter.format(title, System.currentTimeMillis());
            }
            return new ExtractedExtras(alarmId, scheduleId, title, speechText, requestCode);
        }
    }
}
