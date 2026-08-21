package com.timeflow.alarm

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

class LocationModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun getLastKnownLocation(promise: Promise) {
    try {
      val snapshot = readBestLastKnownLocation()
      if (snapshot == null) {
        Log.i(NAME, "getLastKnownLocation no usable cached location")
        promise.resolve(null)
        return
      }

      Log.i(
        NAME,
        "getLastKnownLocation provider=${snapshot.provider} ageMs=${(System.currentTimeMillis() - snapshot.observedAtMillis).coerceAtLeast(0L)} accuracy=${snapshot.accuracyMeters}",
      )
      promise.resolve(snapshot.toWritableMap())
    } catch (error: Exception) {
      promise.reject("LOCATION_FALLBACK_FAILED", error.message, error)
    }
  }

  private fun readBestLastKnownLocation(): LocationSnapshot? {
    if (!hasLocationPermission()) {
      Log.i(NAME, "getLastKnownLocation missing foreground location permission")
      return null
    }

    val locationManager = reactContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      ?: return null
    val snapshots = PROVIDERS.mapNotNull { provider ->
      LocationSnapshotReader.readProviderSnapshot(provider) { currentProvider ->
        locationManager.getLastKnownLocation(currentProvider)?.toSnapshot(currentProvider)
      }
    }
    return LocationSnapshotSelector.chooseBest(snapshots, System.currentTimeMillis())
  }

  private fun hasLocationPermission(): Boolean {
    val fine = ContextCompat.checkSelfPermission(
      reactContext,
      Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED
    val coarse = ContextCompat.checkSelfPermission(
      reactContext,
      Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED
    return fine || coarse
  }

  private fun Location.toSnapshot(provider: String): LocationSnapshot? {
    if (!hasAccuracy() || !accuracy.isFinite() || accuracy < 0f) {
      return null
    }

    return LocationSnapshot(
      provider = provider,
      latitude = latitude,
      longitude = longitude,
      accuracyMeters = accuracy.toDouble(),
      observedAtMillis = time,
    )
  }

  private fun LocationSnapshot.toWritableMap(): WritableMap {
    return Arguments.createMap().apply {
      putString("provider", provider)
      putDouble("latitude", latitude)
      putDouble("longitude", longitude)
      putDouble("accuracyMeters", accuracyMeters)
      putDouble("observedAtMillis", observedAtMillis.toDouble())
    }
  }

  companion object {
    const val NAME = "TimeflowLocation"
    private val PROVIDERS = listOf(
      LocationManager.NETWORK_PROVIDER,
      LocationManager.PASSIVE_PROVIDER,
      LocationManager.GPS_PROVIDER,
      "fused",
    )
  }
}
