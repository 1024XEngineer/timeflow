package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
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
        String speechText = "晨会，时间到了。现在已经09点了。";
        Intent incoming = new Intent(AlarmContract.ACTION_FIRE_ALARM)
                .putExtra(AlarmContract.EXTRA_ALARM_ID, "alarm-1")
                .putExtra(AlarmContract.EXTRA_SCHEDULE_ID, "schedule-1")
                .putExtra(AlarmContract.EXTRA_REQUEST_CODE, 101)
                .putExtra(AlarmContract.EXTRA_TITLE, "晨会")
                .putExtra(AlarmContract.EXTRA_SPEECH_TEXT, speechText);

        new AlarmReceiver().onReceive(context, incoming);

        Intent started = ShadowApplication.getInstance().getNextStartedService();
        assertNotNull(started);
        assertEquals(AlarmSoundService.class.getName(), started.getComponent().getClassName());
        assertEquals(speechText, started.getStringExtra(AlarmContract.EXTRA_SPEECH_TEXT));
    }

    @Test
    public void activityServiceStartForwardsSpeechText() {
        String speechText = "提交报告，时间到了。";

        AlarmSoundService.start(context, "alarm-2", "schedule-2", 202, "提交报告", speechText);

        Intent started = ShadowApplication.getInstance().getNextStartedService();
        assertNotNull(started);
        assertEquals(speechText, started.getStringExtra(AlarmContract.EXTRA_SPEECH_TEXT));
    }
}
