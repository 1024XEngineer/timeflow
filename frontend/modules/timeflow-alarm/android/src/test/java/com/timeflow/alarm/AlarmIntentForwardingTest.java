package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;

/** 闹钟触发的各个 Android Intent handoff 都必须保留 JS 生成的播报文案。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public class AlarmIntentForwardingTest {

    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
    }

    @Test
    public void receiverForwardsSpeechTextToSoundService() {
        String speechText = "提醒你，晨会，别忘了";
        Intent incoming = new Intent(AlarmContract.ACTION_FIRE_ALARM)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, "alarm-1")
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, "schedule-1")
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, 101)
                .putExtra(AlarmContract.EXTRA_TITLE, "晨会")
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, speechText)
                .putExtra(AlarmContract.EXTRA_VIBRATE, false)
                .putExtra(AlarmContract.EXTRA_SOUND_TIER, AlarmContract.SOUND_TIER_FULL)
                .putExtra(AlarmContract.EXTRA_FULL_SCREEN, false);

        new AlarmReceiver().onReceive(context, incoming);

        Intent started = ShadowApplication.getInstance().getNextStartedService();
        assertNotNull(started);
        assertEquals(AlarmSoundService.class.getName(), started.getComponent().getClassName());
        assertEquals(speechText, started.getStringExtra(AlarmContract.EXTRA_SPEECH_TEXT));
        assertFalse(started.getBooleanExtra(AlarmContract.EXTRA_VIBRATE, true));
        assertEquals(
                AlarmContract.SOUND_TIER_FULL,
                started.getStringExtra(AlarmContract.EXTRA_SOUND_TIER)
        );
        assertFalse(started.getBooleanExtra(AlarmContract.EXTRA_FULL_SCREEN, true));
    }

    @Test
    public void activityServiceStartForwardsSpeechText() {
        String speechText = "提醒你，提交报告，别忘了";

        AlarmSoundService.start(
                context,
                "alarm-2",
                "schedule-2",
                202,
                "提交报告",
                true,
                AlarmContract.SOUND_TIER_NONE,
                true,
                speechText
        );

        Intent started = ShadowApplication.getInstance().getNextStartedService();
        assertNotNull(started);
        assertEquals(speechText, started.getStringExtra(AlarmContract.EXTRA_SPEECH_TEXT));
        assertEquals(
                AlarmContract.SOUND_TIER_NONE,
                started.getStringExtra(AlarmContract.EXTRA_SOUND_TIER)
        );
    }
}
