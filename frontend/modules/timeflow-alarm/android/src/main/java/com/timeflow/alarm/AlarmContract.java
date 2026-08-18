package com.timeflow.alarm;

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
}
