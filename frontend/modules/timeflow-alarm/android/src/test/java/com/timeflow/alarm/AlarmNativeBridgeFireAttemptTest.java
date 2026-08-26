package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.Build;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.List;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public class AlarmNativeBridgeFireAttemptTest {

    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        AlarmNativeBridge.ackFireAttempts(context);
    }

    @Test
    public void recordsAndPeeksClosedEnumResultsWithoutScheduleIds() {
        AlarmNativeBridge.recordFireAttempt(context, AlarmNativeBridge.RESULT_SERVICE_DENIED);
        AlarmNativeBridge.recordFireAttempt(context, "not-a-real-result");
        AlarmNativeBridge.recordFireAttempt(context, AlarmNativeBridge.RESULT_PRESENT_FAILED);

        List<AlarmNativeBridge.FireAttemptRecord> rows = AlarmNativeBridge.peekFireAttempts(context);
        assertEquals(2, rows.size());
        assertEquals(AlarmNativeBridge.RESULT_SERVICE_DENIED, rows.get(0).result);
        assertEquals(AlarmNativeBridge.RESULT_PRESENT_FAILED, rows.get(1).result);
        assertTrue(rows.get(0).atMillis > 0);
    }

    @Test
    public void ackClearsPersistedFireAttempts() {
        AlarmNativeBridge.recordFireAttempt(context, AlarmNativeBridge.RESULT_SERVICE_DENIED);
        AlarmNativeBridge.ackFireAttempts(context);
        assertTrue(AlarmNativeBridge.peekFireAttempts(context).isEmpty());
    }
}
