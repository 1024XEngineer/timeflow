package com.timeflow.alarm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class LocationSnapshotSelectorTest {

    private static final long NOW_MILLIS = 100_000L;

    @Test
    public void chooseBest_prefersTheNewestSnapshot() {
        LocationSnapshot oldGps = new LocationSnapshot("gps", 31.0, 121.0, 5.0, 90_000L);
        LocationSnapshot freshNetwork = new LocationSnapshot(
                "network",
                31.187169,
                121.605098,
                30.0,
                95_000L
        );

        LocationSnapshot selected = LocationSnapshotSelector.chooseBest(
                Arrays.asList(oldGps, freshNetwork),
                NOW_MILLIS
        );

        assertEquals("network", selected.getProvider());
        assertEquals(31.187169, selected.getLatitude(), 0.000001);
    }

    @Test
    public void chooseBest_prefersAccuracyWhenTimestampsMatch() {
        LocationSnapshot coarse = new LocationSnapshot("network", 31.0, 121.0, 30.0, 95_000L);
        LocationSnapshot precise = new LocationSnapshot("gps", 31.0, 121.0, 5.0, 95_000L);

        LocationSnapshot selected = LocationSnapshotSelector.chooseBest(
                Arrays.asList(coarse, precise),
                NOW_MILLIS
        );

        assertEquals("gps", selected.getProvider());
    }

    @Test
    public void chooseBest_returnsNullWhenThereAreNoSnapshots() {
        assertNull(LocationSnapshotSelector.chooseBest(Collections.emptyList(), NOW_MILLIS));
    }

    @Test
    public void chooseBest_rejectsSnapshotsOlderThanSixtySeconds() {
        LocationSnapshot stale = new LocationSnapshot("gps", 31.0, 121.0, 5.0, 39_999L);

        assertNull(LocationSnapshotSelector.chooseBest(Collections.singletonList(stale), NOW_MILLIS));
    }

    @Test
    public void chooseBest_rejectsSnapshotsWithoutAnObservationTime() {
        LocationSnapshot missingTime = new LocationSnapshot("gps", 31.0, 121.0, 5.0, 0L);

        assertNull(LocationSnapshotSelector.chooseBest(
                Collections.singletonList(missingTime),
                NOW_MILLIS
        ));
    }

    @Test
    public void chooseBest_rejectsSnapshotsFromTheFuture() {
        LocationSnapshot future = new LocationSnapshot("gps", 31.0, 121.0, 5.0, 100_001L);

        assertNull(LocationSnapshotSelector.chooseBest(Collections.singletonList(future), NOW_MILLIS));
    }

    @Test
    public void chooseBest_rejectsMissingOrInvalidAccuracy() {
        LocationSnapshot negative = new LocationSnapshot("gps", 31.0, 121.0, -1.0, 95_000L);
        LocationSnapshot notANumber = new LocationSnapshot("network", 31.0, 121.0, Double.NaN, 95_000L);

        assertNull(LocationSnapshotSelector.chooseBest(
                Arrays.asList(negative, notANumber),
                NOW_MILLIS
        ));
    }

    @Test
    public void chooseBest_rejectsSnapshotsLessAccurateThanTwoHundredMeters() {
        LocationSnapshot inaccurate = new LocationSnapshot("network", 31.0, 121.0, 200.1, 95_000L);

        assertNull(LocationSnapshotSelector.chooseBest(
                Collections.singletonList(inaccurate),
                NOW_MILLIS
        ));
    }

    @Test
    public void chooseBest_acceptsTheAgeAndAccuracyBoundaries() {
        LocationSnapshot boundary = new LocationSnapshot("network", 31.0, 121.0, 200.0, 40_000L);

        LocationSnapshot selected = LocationSnapshotSelector.chooseBest(
                Collections.singletonList(boundary),
                NOW_MILLIS
        );

        assertEquals("network", selected.getProvider());
    }
}
