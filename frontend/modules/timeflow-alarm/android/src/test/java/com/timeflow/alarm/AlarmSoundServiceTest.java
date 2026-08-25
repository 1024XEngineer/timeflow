package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSettings;

import java.util.List;

/**
 * 覆盖 Wintercom 在 PR #265 review 里要求的场景：两条闹钟重叠到达时都应该被展示、
 * 各自的 disposition 不能串。不覆盖悬浮窗按钮点击 -> snooze/dismiss 这条链路（需要真的
 * 构建 AlarmRingUi 的 View），也不覆盖 MediaPlayer/TTS 播放（跟系统资源强绑定，presentAlarm()
 * 本身已经有 try/catch 兜底）。
 *
 * pin 住 API 34：这个模块 compileSdk 是 35，但 API 36 常量已经在生产代码里被移除
 * （见 AlarmSoundService#backgroundActivityStartMode），34 是 minSdk 24 到 targetSdk 35
 * 之间已经被广泛验证过的 Robolectric shadow 版本，用来降低这次从零搭 Robolectric 的风险。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public class AlarmSoundServiceTest {

    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        // 允许悬浮窗权限，否则 showAlarmOverlay() 会直接跳过，overlayView 永远是 null，
        // 排队逻辑（判断依据是 overlayView != null）根本走不到。
        ShadowSettings.setCanDrawOverlays(true);
    }

    @Test
    public void secondOverlappingAlarm_isQueuedThenShownAfterFirstAdvances() {
        AlarmSoundService service = Robolectric.buildService(AlarmSoundService.class).create().get();

        service.onStartCommand(alarmIntent("alarm-1", "schedule-1", "第一条提醒", 100), 0, 1);

        assertEquals("alarm-1", service.alarmId);
        assertNotNull("第一条闹钟应该已经把悬浮窗建起来", service.overlayView);
        assertTrue("第一条展示完队列应该还是空的", service.pendingQueue.isEmpty());
        assertEquals("pending", dispositionState("schedule-1"));

        service.onStartCommand(alarmIntent("alarm-2", "schedule-2", "第二条提醒", 200), 0, 2);

        assertEquals(
                "界面被第一条占用时，第二条不该覆盖当前展示的闹钟",
                "alarm-1",
                service.alarmId
        );
        assertEquals(1, service.pendingQueue.size());
        assertEquals("alarm-2", service.pendingQueue.peek().alarmId);
        assertEquals(
                "排队中的闹钟也要立刻记 pending，不能等真正展示才记",
                "pending",
                dispositionState("schedule-2")
        );

        service.advanceOrStop();

        assertEquals("处理完第一条后应该顶上第二条", "alarm-2", service.alarmId);
        assertEquals("schedule-2", service.scheduleId);
        assertTrue("顶上第二条之后队列应该清空", service.pendingQueue.isEmpty());
        assertNotNull("第二条也应该真的建起悬浮窗，而不是被静默丢弃", service.overlayView);
    }

    @Test
    public void extractedExtras_carriesSpeechText() {
        Intent intent = new Intent(context, AlarmSoundService.class)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, "alarm-tts")
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, "开会，在家");
        AlarmContract.ExtractedExtras extras = AlarmContract.ExtractedExtras.from(context, intent);
        assertEquals("开会，在家", extras.speechText);
    }

    @Test
    public void advanceOrStop_stopsSelfWhenQueueEmpty() {
        AlarmSoundService service = Robolectric.buildService(AlarmSoundService.class).create().get();
        service.onStartCommand(alarmIntent("alarm-1", "schedule-1", "唯一的提醒", 100), 0, 1);

        service.advanceOrStop();

        assertTrue(
                "队列空了应该真的停服务，而不是继续占着不放",
                Shadows.shadowOf(service).isStoppedBySelf()
        );
    }

    private Intent alarmIntent(String alarmId, String scheduleId, String title, int requestCode) {
        return new Intent(context, AlarmSoundService.class)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, alarmId)
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, scheduleId)
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, requestCode)
                .putExtra(AlarmContract.EXTRA_TITLE, title);
    }

    private String dispositionState(String scheduleId) {
        List<AlarmNativeBridge.DispositionRecord> records = AlarmNativeBridge.peekDispositions(context);
        for (AlarmNativeBridge.DispositionRecord record : records) {
            if (scheduleId.equals(record.scheduleId)) {
                return record.state;
            }
        }
        return null;
    }
}
