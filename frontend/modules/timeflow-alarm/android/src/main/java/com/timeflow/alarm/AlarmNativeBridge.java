package com.timeflow.alarm;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 持久化原生 fire/dismiss，供 JS 在进程死后补水 disposition；
 * 并在 React 上下文存活时向 AlarmModule 转发事件。
 */
public final class AlarmNativeBridge {
    private AlarmNativeBridge() {
    }

    public static final class DispositionRecord {
        public final String scheduleId;
        public final String alarmId;
        public final String state;
        public final long updatedAtMillis;

        DispositionRecord(String scheduleId, String alarmId, String state, long updatedAtMillis) {
            this.scheduleId = scheduleId;
            this.alarmId = alarmId;
            this.state = state;
            this.updatedAtMillis = updatedAtMillis;
        }
    }

    public static void notifyFired(
            Context context,
            String scheduleId,
            String alarmId,
            String title
    ) {
        upsertDisposition(context, scheduleId, alarmId, "pending");
        sendLocalEvent(context, AlarmContract.EVENT_FIRED, scheduleId, alarmId, title);
        AlarmModule.emitAlarmEvent(AlarmContract.EVENT_FIRED, scheduleId, alarmId, title);
    }

    public static void notifyDismissed(
            Context context,
            String scheduleId,
            String alarmId,
            String title
    ) {
        upsertDisposition(context, scheduleId, alarmId, "confirmed");
        sendLocalEvent(context, AlarmContract.EVENT_DISMISSED, scheduleId, alarmId, title);
        AlarmModule.emitAlarmEvent(AlarmContract.EVENT_DISMISSED, scheduleId, alarmId, title);
    }

    /** 延后：落 snoozed disposition，并由调用方负责重新 schedule。 */
    public static void notifySnoozed(
            Context context,
            String scheduleId,
            String alarmId,
            String title
    ) {
        upsertDisposition(context, scheduleId, alarmId, "snoozed");
        sendLocalEvent(context, AlarmContract.EVENT_SNOOZED, scheduleId, alarmId, title);
        AlarmModule.emitAlarmEvent(AlarmContract.EVENT_SNOOZED, scheduleId, alarmId, title);
    }

    public static List<DispositionRecord> consumeDispositions(Context context) {
        SharedPreferences preferences =
                context.getSharedPreferences(AlarmContract.PREFS_NAME, Context.MODE_PRIVATE);
        String serialized = preferences.getString(AlarmContract.DISPOSITIONS_KEY, "[]");
        List<DispositionRecord> records = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(serialized);
            for (int index = 0; index < array.length(); index++) {
                Object value = array.get(index);
                if (!(value instanceof JSONObject)) {
                    continue;
                }
                JSONObject object = (JSONObject) value;
                String scheduleId = object.optString("schedule_id", "");
                String state = object.optString("state", "");
                if (scheduleId.isEmpty() || state.isEmpty()) {
                    continue;
                }
                records.add(new DispositionRecord(
                        scheduleId,
                        object.optString("alarm_id", ""),
                        state,
                        object.optLong("updated_at", System.currentTimeMillis())
                ));
            }
        } catch (JSONException ignored) {
            records.clear();
        }
        preferences.edit().putString(AlarmContract.DISPOSITIONS_KEY, "[]").apply();
        return records;
    }

    public static void stopRinging(Context context) {
        AlarmSoundService.stop(context);
        RingActivity.finishIfOpen();
    }

    private static void sendLocalEvent(
            Context context,
            String type,
            String scheduleId,
            String alarmId,
            String title
    ) {
        Intent intent = new Intent(AlarmContract.ACTION_ALARM_EVENT)
                .setPackage(context.getPackageName())
                .putExtra(AlarmContract.EXTRA_EVENT_TYPE, type)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_TITLE, title);
        context.sendBroadcast(intent);
    }

    private static void upsertDisposition(
            Context context,
            String scheduleId,
            String alarmId,
            String state
    ) {
        if (scheduleId == null || scheduleId.isEmpty()) {
            return;
        }
        SharedPreferences preferences =
                context.getSharedPreferences(AlarmContract.PREFS_NAME, Context.MODE_PRIVATE);
        String serialized = preferences.getString(AlarmContract.DISPOSITIONS_KEY, "[]");
        JSONArray remaining = new JSONArray();
        try {
            JSONArray array = new JSONArray(serialized);
            for (int index = 0; index < array.length(); index++) {
                Object value = array.get(index);
                if (!(value instanceof JSONObject)) {
                    continue;
                }
                JSONObject object = (JSONObject) value;
                if (scheduleId.equals(object.optString("schedule_id", ""))) {
                    continue;
                }
                remaining.put(object);
            }
            JSONObject next = new JSONObject();
            next.put("schedule_id", scheduleId);
            next.put("alarm_id", alarmId == null ? "" : alarmId);
            next.put("state", state);
            next.put("updated_at", System.currentTimeMillis());
            remaining.put(next);
        } catch (JSONException ignored) {
            return;
        }
        preferences.edit()
                .putString(AlarmContract.DISPOSITIONS_KEY, remaining.toString())
                .apply();
    }
}
