package com.timeflow.alarm;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class ReminderSpeechFormatterTest {

    @Test
    public void format_withTitleAndTime_returnsCorrectText() {
        // 15:30 -> 15点30分
        long triggerAt = createTimestamp(2024, 10, 15, 15, 30);
        String result = ReminderSpeechFormatter.format("项目复盘", triggerAt);
        assertEquals("项目复盘，时间到了。现在已经15点30分了。", result);
    }

    @Test
    public void format_withZeroMinute_omitsZero() {
        // 15:00 -> 15点
        long triggerAt = createTimestamp(2024, 10, 15, 15, 0);
        String result = ReminderSpeechFormatter.format("会议", triggerAt);
        assertEquals("会议，时间到了。现在已经15点了。", result);
    }

    @Test
    public void format_withNullTitle_usesFallback() {
        long triggerAt = createTimestamp(2024, 10, 15, 15, 30);
        String result = ReminderSpeechFormatter.format(null, triggerAt);
        assertEquals("未命名日程，时间到了。现在已经15点30分了。", result);
    }

    @Test
    public void format_withEmptyTitle_usesFallback() {
        long triggerAt = createTimestamp(2024, 10, 15, 15, 30);
        String result = ReminderSpeechFormatter.format("   ", triggerAt);
        assertEquals("未命名日程，时间到了。现在已经15点30分了。", result);
    }

    @Test
    public void format_withLongTitle_truncatesTo80Chars() {
        String longTitle = "这是一个非常非常长的标题，超过了80个字符的限制，需要被正确截断以确保语音播报的完整性测试这个功能是否正常工作";
        long triggerAt = createTimestamp(2024, 10, 15, 15, 30);
        String result = ReminderSpeechFormatter.format(longTitle, triggerAt);
        assertTrue("Title should be truncated to 80 chars", result.indexOf("，") <= 80);
    }

    @Test
    public void format_withWhitespaceInTitle_normalizes() {
        long triggerAt = createTimestamp(2024, 10, 15, 15, 30);
        String result = ReminderSpeechFormatter.format("  项目  复盘  ", triggerAt);
        assertEquals("项目 复盘，时间到了。现在已经15点30分了。", result);
    }

    private long createTimestamp(int year, int month, int day, int hour, int minute) {
        java.util.Calendar cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        cal.set(year, month - 1, day, hour, minute, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }
}
