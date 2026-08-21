package com.timeflow.alarm;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * 在没有有效 speech_text 时（老版本闹钟数据）生成兜底文案。
 * 文案格式：{标题}，时间到了。现在已经{小时}点{分钟}了。
 */
public final class ReminderSpeechFormatter {
    private static final int MAX_TITLE_LENGTH = 80;
    private static final String FALLBACK_TITLE = "未命名日程";

    private ReminderSpeechFormatter() {
    }

    /**
     * 生成兜底语音文案。
     *
     * @param title           日程标题
     * @param triggerAtMillis 触发时间戳
     * @return 语音文案
     */
    public static String format(String title, long triggerAtMillis) {
        String normalizedTitle = normalizeTitle(title);
        String timeText = formatTime(triggerAtMillis);
        return normalizedTitle + "，时间到了。现在已经" + timeText + "了。";
    }

    private static String normalizeTitle(String title) {
        if (title == null) {
            return FALLBACK_TITLE;
        }
        String trimmed = title.trim().replaceAll("\\s+", " ");
        if (trimmed.isEmpty()) {
            return FALLBACK_TITLE;
        }
        if (trimmed.length() > MAX_TITLE_LENGTH) {
            return trimmed.substring(0, MAX_TITLE_LENGTH);
        }
        return trimmed;
    }

    private static String formatTime(long triggerAtMillis) {
        try {
            SimpleDateFormat sdf = new SimpleDateFormat("HH:mm", Locale.CHINA);
            String timeStr = sdf.format(new Date(triggerAtMillis));
            String[] parts = timeStr.split(":");
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            if (minute == 0) {
                return hour + "点";
            }
            return hour + "点" + minute + "分";
        } catch (Exception e) {
            return "现在";
        }
    }
}
