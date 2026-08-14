package com.timeflow.baidulocation

import android.util.Log
import com.baidu.location.BDAbstractLocationListener
import com.baidu.location.BDLocation
import com.baidu.location.LocationClient
import com.baidu.location.LocationClientOption
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 百度连续定位桥：不使用 Google Geofencing。
 * 坐标系默认 gcj02，便于与国内常见选点坐标对齐后做 Haversine。
 */
class BaiduLocationModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private var client: LocationClient? = null
  private var updating = false
  private var lastLocation: WritableMap? = null

  private val isoFormat =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }

  private val listener =
    object : BDAbstractLocationListener() {
      override fun onReceiveLocation(location: BDLocation?) {
        if (location == null) return
        if (!isUsableLocation(location)) {
          Log.w(NAME, "ignore locType=${location.locType}")
          return
        }

        val payload = Arguments.createMap()
        payload.putDouble("latitude", location.latitude)
        payload.putDouble("longitude", location.longitude)
        payload.putDouble(
          "accuracy",
          if (location.radius > 0) location.radius.toDouble() else 0.0,
        )
        payload.putString("observedAt", isoFormat.format(Date()))
        payload.putInt("locType", location.locType)
        lastLocation = copyMap(payload)

        if (reactContext.hasActiveReactInstance()) {
          reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_LOCATION, payload)
        }
      }
    }

  override fun getName(): String = NAME

  @ReactMethod
  fun setAgreePrivacy(agree: Boolean, promise: Promise) {
    try {
      LocationClient.setAgreePrivacy(agree)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("PRIVACY_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun init(ak: String?, promise: Promise) {
    try {
      LocationClient.setAgreePrivacy(true)
      if (client == null) {
        client = LocationClient(reactContext.applicationContext)
        client?.registerLocationListener(listener)
      }
      if (!ak.isNullOrBlank()) {
        Log.i(NAME, "init akLength=${ak.length}")
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("INIT_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun startUpdating(intervalMs: Double, promise: Promise) {
    try {
      LocationClient.setAgreePrivacy(true)
      val locationClient =
        client ?: LocationClient(reactContext.applicationContext).also {
          it.registerLocationListener(listener)
          client = it
        }

      val span = intervalMs.toInt().coerceAtLeast(1000)
      val option = LocationClientOption()
      option.locationMode = LocationClientOption.LocationMode.Hight_Accuracy
      option.setCoorType("gcj02")
      option.setScanSpan(span)
      option.isOpenGps = true
      option.setIsNeedAddress(false)
      option.setNeedNewVersionRgc(false)
      locationClient.locOption = option

      if (!updating) {
        locationClient.start()
        updating = true
      } else {
        locationClient.restart()
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stopUpdating(promise: Promise) {
    try {
      client?.stop()
      updating = false
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("STOP_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun getCurrentPosition(promise: Promise) {
    val cached = lastLocation
    if (cached != null) {
      promise.resolve(copyMap(cached))
      return
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun addListener(eventName: String?) {
    // RN event emitter bookkeeping.
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    // RN event emitter bookkeeping.
  }

  override fun invalidate() {
    try {
      client?.unRegisterLocationListener(listener)
      client?.stop()
    } catch (_: Exception) {
    }
    client = null
    updating = false
    super.invalidate()
  }

  companion object {
    const val NAME = "TimeflowBaiduLocation"
    const val EVENT_LOCATION = "TimeflowBaiduLocation"

    private fun isUsableLocation(location: BDLocation): Boolean {
      if (location.latitude == 0.0 && location.longitude == 0.0) return false
      // 常见成功：61 GPS、161 网络、66 离线；其它带有效坐标的也接受。
      return when (location.locType) {
        BDLocation.TypeGpsLocation,
        BDLocation.TypeNetWorkLocation,
        BDLocation.TypeOffLineLocation,
        BDLocation.TypeCacheLocation,
        -> true
        else -> location.radius > 0
      }
    }

    private fun copyMap(source: WritableMap): WritableMap {
      val copy = Arguments.createMap()
      copy.merge(source)
      return copy
    }
  }
}
