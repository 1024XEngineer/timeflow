package com.timeflow.alarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 与 UI 无关的 AlarmManager 调度器。
 * 持久化 UUID / scheduleId / triggerAtMillis / requestCode，供精确取消与 rebuild。
 */
public final class AlarmScheduler {
    private AlarmScheduler() {
    }

    public static final class AlarmRecord {
        public final String alarmId;
        public final String scheduleId;
        public final long triggerAtMillis;
        public final int requestCode;
        public final String title;
        public final String speechText;
        public final boolean legacy;
        public final boolean vibrate;
        public final String soundTier;
        public final boolean fullScreen;

        AlarmRecord(
                String alarmId,
                String scheduleId,
                long triggerAtMillis,
                int requestCode,
                String title,
                String speechText,
                boolean legacy,
                boolean vibrate,
                String soundTier,
                boolean fullScreen
        ) {
            this.alarmId = alarmId;
            this.scheduleId = scheduleId == null ? "" : scheduleId;
            this.triggerAtMillis = triggerAtMillis;
            this.requestCode = requestCode;
            this.title = title;
            this.speechText = speechText == null ? "" : speechText;
            this.legacy = legacy;
            this.vibrate = vibrate;
            this.soundTier = soundTier == null || soundTier.isEmpty()
                    ? AlarmContract.SOUND_TIER_FULL : soundTier;
            this.fullScreen = fullScreen;
        }
    }

    public static String schedule(
            Context context,
            long triggerAtMillis,
            String title,
            String scheduleId,
            boolean vibrate,
            String soundTier,
            boolean fullScreen,
            String speechText
    ) {
        if (triggerAtMillis <= System.currentTimeMillis()) {
            throw new IllegalArgumentException("trigger_in_past");
        }

        AlarmManager alarmManager =
                (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            throw new IllegalStateException("alarm_manager_unavailable");
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S
                && !alarmManager.canScheduleExactAlarms()) {
            throw new SecurityException("exact_alarm_denied");
        }

        if (scheduleId != null && !scheduleId.isEmpty()) {
            cancelByScheduleId(context, scheduleId);
        }

        List<AlarmRecord> alarms = loadAlarms(context);
        String alarmId = UUID.randomUUID().toString();
        AlarmRecord record = new AlarmRecord(
                alarmId,
                scheduleId == null ? "" : scheduleId,
                triggerAtMillis,
                nextRequestCode(alarms),
                title == null ? "" : title,
                speechText == null ? "" : speechText,
                false,
                vibrate,
                soundTier,
                fullScreen
        );

        rearm(context, alarmManager, record);

        alarms.add(record);
        saveAlarms(context, alarms);
        return alarmId;
    }

    /** @deprecated 请改用 {@link #schedule(Context, long, String, String, boolean, String, boolean, String)}。 */
    @Deprecated
    public static String schedule(
            Context context, long triggerAtMillis, String title, String scheduleId
    ) {
        return schedule(
                context, triggerAtMillis, title, scheduleId, true,
                AlarmContract.SOUND_TIER_FULL, true, ""
        );
    }

    /** @deprecated 请改用 {@link #schedule(Context, long, String, String, boolean, String, boolean, String)}。 */
    @Deprecated
    public static String schedule(Context context, long triggerAtMillis, String title) {
        return schedule(
                context, triggerAtMillis, title, "", true, AlarmContract.SOUND_TIER_FULL, true, ""
        );
    }

    /**
     * 系统重启 / 应用更新后重新挂上所有还没过期的持久化闹钟。
     * AlarmManager 的注册在这两种情况下都会被系统清空，但 SharedPreferences 里的记录还在；
     * 不重新挂，用户在下次自己打开 App 之前不会再收到任何提醒。
     * <p>
     * 已经过期的记录直接从持久化列表里丢弃，不在这里补响——JS 侧
     * {@code LocalReminderApplication} 自己会在下次 rebuild 时把错过的提醒当到点处理，
     * 这里再触发一次会导致同一条提醒响两次。
     */
    public static void rescheduleAfterBoot(Context context) {
        AlarmManager alarmManager =
                (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return;
        }
        boolean canScheduleExact = android.os.Build.VERSION.SDK_INT
                < android.os.Build.VERSION_CODES.S
                || alarmManager.canScheduleExactAlarms();

        long now = System.currentTimeMillis();
        List<AlarmRecord> survivors = new ArrayList<>();
        for (AlarmRecord record : loadAlarms(context)) {
            if (record.triggerAtMillis <= now || !canScheduleExact) {
                continue;
            }
            rearm(context, alarmManager, record);
            survivors.add(record);
        }
        saveAlarms(context, survivors);
    }

    private static void rearm(Context context, AlarmManager alarmManager, AlarmRecord record) {
        PendingIntent operation = buildAlarmBroadcastPendingIntent(
                context,
                record,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent showIntent = context.getPackageManager()
                .getLaunchIntentForPackage(context.getPackageName());
        if (showIntent == null) {
            showIntent = new Intent(Intent.ACTION_MAIN)
                    .setPackage(context.getPackageName());
        }
        showIntent.setData(alarmUri(record.alarmId))
                .putExtra(AlarmContract.EXTRA_ALARM_ID, record.alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, record.scheduleId)
                .putExtra(AlarmContract.EXTRA_TITLE, record.title)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, record.speechText)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, record.requestCode)
                .putExtra(AlarmContract.EXTRA_VIBRATE, record.vibrate)
                .putExtra(AlarmContract.EXTRA_SOUND_TIER, record.soundTier)
                .putExtra(AlarmContract.EXTRA_FULL_SCREEN, record.fullScreen)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent showPendingIntent = PendingIntent.getActivity(
                context,
                record.requestCode,
                showIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        alarmManager.setAlarmClock(
                new AlarmManager.AlarmClockInfo(record.triggerAtMillis, showPendingIntent),
                operation
        );
    }

    public static boolean cancel(Context context, String alarmId) {
        if (alarmId == null || alarmId.isEmpty()) {
            return false;
        }
        List<AlarmRecord> alarms = loadAlarms(context);
        int index = indexById(alarms, alarmId);
        if (index < 0) {
            return false;
        }

        AlarmRecord record = alarms.get(index);
        cancelPendingIntent(context, record);
        alarms.remove(index);
        saveAlarms(context, alarms);
        return true;
    }

    public static int cancelByScheduleId(Context context, String scheduleId) {
        if (scheduleId == null || scheduleId.isEmpty()) {
            return 0;
        }
        List<AlarmRecord> alarms = loadAlarms(context);
        List<AlarmRecord> remaining = new ArrayList<>();
        int cancelled = 0;
        for (AlarmRecord record : alarms) {
            if (scheduleId.equals(record.scheduleId)) {
                cancelPendingIntent(context, record);
                cancelled += 1;
            } else {
                remaining.add(record);
            }
        }
        if (cancelled > 0) {
            saveAlarms(context, remaining);
        }
        return cancelled;
    }

    public static int cancelAll(Context context) {
        List<AlarmRecord> alarms = loadAlarms(context);
        for (AlarmRecord record : alarms) {
            cancelPendingIntent(context, record);
        }
        saveAlarms(context, new ArrayList<AlarmRecord>());
        return alarms.size();
    }

    public static List<AlarmRecord> loadAlarms(Context context) {
        SharedPreferences preferences =
                context.getSharedPreferences(AlarmContract.PREFS_NAME, Context.MODE_PRIVATE);
        String serialized = preferences.getString(AlarmContract.ALARMS_KEY, "[]");
        List<AlarmRecord> alarms = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(serialized);
            for (int index = 0; index < array.length(); index++) {
                Object value = array.get(index);
                if (!(value instanceof JSONObject)) {
                    continue;
                }
                JSONObject object = (JSONObject) value;
                long triggerAt = object.optLong("trigger_at", -1L);
                int requestCode = object.optInt("request_code", -1);
                if (triggerAt <= 0 || requestCode < 0) {
                    continue;
                }
                String alarmId = object.optString("alarm_id", "");
                boolean legacy = object.optBoolean("legacy", alarmId.isEmpty());
                if (alarmId.isEmpty()) {
                    alarmId = "legacy-" + requestCode;
                }
                alarms.add(new AlarmRecord(
                        alarmId,
                        object.optString("schedule_id", ""),
                        triggerAt,
                        requestCode,
                        object.optString("title", ""),
                        object.optString("speech_text", ""),
                        legacy,
                        object.optBoolean("vibrate", true),
                        object.optString("sound_tier", AlarmContract.SOUND_TIER_FULL),
                        object.optBoolean("full_screen", true)
                ));
            }
        } catch (JSONException ignored) {
            alarms.clear();
        }
        return alarms;
    }

    static void removeAlarmRecord(Context context, String alarmId, int requestCode) {
        List<AlarmRecord> alarms = loadAlarms(context);
        JSONArray remaining = new JSONArray();
        for (AlarmRecord alarm : alarms) {
            boolean match;
            if (!alarm.alarmId.isEmpty()) {
                match = alarm.alarmId.equals(alarmId);
            } else {
                match = alarm.requestCode == requestCode;
            }
            if (match) {
                continue;
            }
            try {
                remaining.put(toJson(alarm));
            } catch (JSONException ignored) {
                // 忽略单条序列化失败
            }
        }
        context.getSharedPreferences(AlarmContract.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(AlarmContract.ALARMS_KEY, remaining.toString())
                .apply();
    }

    static Uri alarmUri(String alarmId) {
        return Uri.parse(
                AlarmContract.ALARM_URI_SCHEME + "://alarm/" + Uri.encode(alarmId)
        );
    }

    static String scheduleIdForAlarm(Context context, String alarmId) {
        if (alarmId == null || alarmId.isEmpty()) {
            return "";
        }
        for (AlarmRecord alarm : loadAlarms(context)) {
            if (alarmId.equals(alarm.alarmId)) {
                return alarm.scheduleId;
            }
        }
        return "";
    }

    /** Stable positive notification/foreground-service id for an immediate alarm. */
    static int immediateRequestCode(String alarmId) {
        int requestCode = alarmId == null ? 1 : alarmId.hashCode() & 0x7fffffff;
        return requestCode == 0 ? 1 : requestCode;
    }

    private static void cancelPendingIntent(Context context, AlarmRecord record) {
        AlarmManager alarmManager =
                (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            return;
        }
        PendingIntent operation = buildAlarmBroadcastPendingIntent(
                context,
                record,
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
        );
        if (operation != null) {
            alarmManager.cancel(operation);
            operation.cancel();
        }
    }

    private static void saveAlarms(Context context, List<AlarmRecord> alarms) {
        JSONArray array = new JSONArray();
        for (AlarmRecord alarm : alarms) {
            try {
                array.put(toJson(alarm));
            } catch (JSONException ignored) {
                // 忽略单条序列化失败
            }
        }
        context.getSharedPreferences(AlarmContract.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(AlarmContract.ALARMS_KEY, array.toString())
                .apply();
    }

    private static JSONObject toJson(AlarmRecord alarm) throws JSONException {
        JSONObject object = new JSONObject();
        object.put("alarm_id", alarm.alarmId);
        object.put("schedule_id", alarm.scheduleId);
        object.put("trigger_at", alarm.triggerAtMillis);
        object.put("request_code", alarm.requestCode);
        object.put("title", alarm.title);
        object.put("speech_text", alarm.speechText);
        object.put("legacy", alarm.legacy);
        object.put("vibrate", alarm.vibrate);
        object.put("sound_tier", alarm.soundTier);
        object.put("full_screen", alarm.fullScreen);
        object.put("speech_text", alarm.speechText);
        return object;
    }

    private static PendingIntent buildAlarmBroadcastPendingIntent(
            Context context,
            AlarmRecord record,
            int flags
    ) {
        Intent intent = new Intent(context, AlarmReceiver.class)
                .setAction(AlarmContract.ACTION_FIRE_ALARM)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, record.alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, record.scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, record.requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, record.title)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, record.speechText)
                .putExtra(AlarmContract.EXTRA_VIBRATE, record.vibrate)
                .putExtra(AlarmContract.EXTRA_SOUND_TIER, record.soundTier)
                .putExtra(AlarmContract.EXTRA_FULL_SCREEN, record.fullScreen)
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, record.speechText);
        if (!record.legacy) {
            intent.setData(alarmUri(record.alarmId));
        }
        return PendingIntent.getBroadcast(context, record.requestCode, intent, flags);
    }

    private static int nextRequestCode(List<AlarmRecord> alarms) {
        int requestCode = (int) (System.currentTimeMillis() & 0x7fffffff);
        if (requestCode == 0) {
            requestCode = 1;
        }
        while (containsRequestCode(alarms, requestCode)) {
            requestCode = requestCode == Integer.MAX_VALUE ? 1 : requestCode + 1;
        }
        return requestCode;
    }

    private static boolean containsRequestCode(List<AlarmRecord> alarms, int requestCode) {
        for (AlarmRecord alarm : alarms) {
            if (alarm.requestCode == requestCode) {
                return true;
            }
        }
        return false;
    }

    private static int indexById(List<AlarmRecord> alarms, String alarmId) {
        for (int index = 0; index < alarms.size(); index++) {
            if (alarms.get(index).alarmId.equals(alarmId)) {
                return index;
            }
        }
        return -1;
    }
}
