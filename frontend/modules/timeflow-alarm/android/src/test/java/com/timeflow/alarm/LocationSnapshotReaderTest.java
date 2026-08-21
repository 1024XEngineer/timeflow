package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicBoolean;

public class LocationSnapshotReaderTest {
    @Test
    public void readProviderSnapshot_alwaysAttemptsTheCachedLocationRead() {
        AtomicBoolean cacheRead = new AtomicBoolean(false);
        LocationSnapshot cached = new LocationSnapshot("network", 12.345678, 98.765432, 31.0, 2_000L);

        LocationSnapshot snapshot = LocationSnapshotReader.readProviderSnapshot("network", provider -> {
            cacheRead.set(true);
            assertEquals("network", provider);
            return cached;
        });

        assertTrue(cacheRead.get());
        assertSame(cached, snapshot);
    }

    @Test
    public void readProviderSnapshot_returnsNullWhenTheProviderReadFails() {
        LocationSnapshot snapshot = LocationSnapshotReader.readProviderSnapshot("missing", provider -> {
            throw new IllegalArgumentException("provider unavailable");
        });

        assertNull(snapshot);
    }
}
