package com.timeflow.alarm

data class LocationSnapshot(
  val provider: String,
  val latitude: Double,
  val longitude: Double,
  val accuracyMeters: Double,
  val observedAtMillis: Long,
)

object LocationSnapshotSelector {
  @JvmStatic
  fun chooseBest(
    candidates: List<LocationSnapshot>,
    nowMillis: Long,
  ): LocationSnapshot? {
    return candidates
      .asSequence()
      .filter { snapshot -> isValid(snapshot, nowMillis) }
      .maxWithOrNull(
        compareBy<LocationSnapshot> { it.observedAtMillis }
          .thenBy { -it.accuracyMeters },
      )
  }

  private fun isValid(snapshot: LocationSnapshot, nowMillis: Long): Boolean {
    val hasAcceptableAge = snapshot.observedAtMillis > 0L &&
      snapshot.observedAtMillis <= nowMillis &&
      nowMillis - snapshot.observedAtMillis <= MAX_AGE_MS

    return snapshot.latitude.isFinite() &&
      snapshot.longitude.isFinite() &&
      snapshot.accuracyMeters.isFinite() &&
      snapshot.latitude in -90.0..90.0 &&
      snapshot.longitude in -180.0..180.0 &&
      snapshot.accuracyMeters in 0.0..MAX_ACCURACY_METERS &&
      hasAcceptableAge
  }

  private const val MAX_AGE_MS = 60_000L
  private const val MAX_ACCURACY_METERS = 200.0
}
