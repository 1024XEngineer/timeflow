package com.timeflow.alarm

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.lang.ref.WeakReference

class AlarmModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  init {
    reactContextRef = WeakReference(reactContext)
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
    // NativeEventEmitter 要求存在该方法。
  }

  @ReactMethod
  fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {
    // NativeEventEmitter 要求存在该方法。
  }

  @ReactMethod
  fun schedule(
    triggerAtMillis: Double,
    title: String?,
    scheduleId: String?,
    promise: Promise,
  ) {
    try {
      Log.i(NAME, "schedule triggerAtMillis=$triggerAtMillis title=$title scheduleId=$scheduleId")
      val alarmId = AlarmScheduler.schedule(
        reactContext,
        triggerAtMillis.toLong(),
        title ?: "日程提醒",
        scheduleId ?: "",
      )
      Log.i(NAME, "scheduled alarmId=$alarmId")
      val result: WritableMap = Arguments.createMap()
      result.putString("alarmId", alarmId)
      result.putString("scheduleId", scheduleId ?: "")
      promise.resolve(result)
    } catch (error: IllegalArgumentException) {
      promise.reject("TRIGGER_IN_PAST", error.message, error)
    } catch (error: SecurityException) {
      promise.reject("EXACT_ALARM_DENIED", error.message, error)
    } catch (error: Exception) {
      promise.reject("SCHEDULE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun cancel(alarmId: String?, promise: Promise) {
    try {
      val cancelled = AlarmScheduler.cancel(reactContext, alarmId)
      promise.resolve(cancelled)
    } catch (error: Exception) {
      promise.reject("CANCEL_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun cancelAll(promise: Promise) {
    try {
      val cancelled = AlarmScheduler.cancelAll(reactContext)
      promise.resolve(cancelled)
    } catch (error: Exception) {
      promise.reject("CANCEL_ALL_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stopRinging(promise: Promise) {
    try {
      AlarmNativeBridge.stopRinging(reactContext)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("STOP_RINGING_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun consumeNativeDispositions(promise: Promise) {
    try {
      val records = AlarmNativeBridge.consumeDispositions(reactContext)
      val array: WritableArray = Arguments.createArray()
      for (record in records) {
        val item = Arguments.createMap()
        item.putString("scheduleId", record.scheduleId)
        item.putString("alarmId", record.alarmId)
        item.putString("state", record.state)
        item.putDouble("updatedAtMillis", record.updatedAtMillis.toDouble())
        array.pushMap(item)
      }
      promise.resolve(array)
    } catch (error: Exception) {
      promise.reject("CONSUME_DISPOSITIONS_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun getPermissionStatus(promise: Promise) {
    try {
      val status = Arguments.createMap()
      val alarmManager =
        reactContext.getSystemService(AlarmManager::class.java)
      val exactAlarm = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        true
      } else {
        alarmManager?.canScheduleExactAlarms() == true
      }
      status.putBoolean("exactAlarm", exactAlarm)

      val overlay = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        true
      } else {
        Settings.canDrawOverlays(reactContext)
      }
      status.putBoolean("overlay", overlay)

      val notificationManager =
        reactContext.getSystemService(NotificationManager::class.java)
      val fullScreen = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        true
      } else {
        notificationManager?.canUseFullScreenIntent() == true
      }
      status.putBoolean("fullScreen", fullScreen)

      val notifications = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        true
      } else {
        ContextCompatPermissionGranted(reactContext)
      }
      status.putBoolean("notifications", notifications)

      val powerManager = reactContext.getSystemService(PowerManager::class.java)
      val battery = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        true
      } else {
        powerManager?.isIgnoringBatteryOptimizations(reactContext.packageName) == true
      }
      status.putBoolean("battery", battery)

      promise.resolve(status)
    } catch (error: Exception) {
      promise.reject("PERMISSION_STATUS_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun openPermissionSettings(kind: String?, promise: Promise) {
    try {
      val pkg = Uri.parse("package:${reactContext.packageName}")
      val intent = when (kind) {
        "exactAlarm" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)
        "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg)
        "fullScreen" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
        } else {
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        }
        "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
        else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("OPEN_SETTINGS_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun requestNotificationPermission(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      promise.resolve(true)
      return
    }
    if (ContextCompatPermissionGranted(reactContext)) {
      promise.resolve(true)
      return
    }
    val activity = reactContext.currentActivity
    if (activity !is PermissionAwareActivity) {
      promise.reject("NO_ACTIVITY", "PermissionAwareActivity unavailable")
      return
    }
    val listener = PermissionListener { requestCode, _, grantResults ->
      if (requestCode != NOTIFICATION_REQUEST_CODE) {
        return@PermissionListener false
      }
      val granted = grantResults.isNotEmpty() &&
        grantResults[0] == PackageManager.PERMISSION_GRANTED
      promise.resolve(granted)
      true
    }
    activity.requestPermissions(
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      NOTIFICATION_REQUEST_CODE,
      listener,
    )
  }

  companion object {
    const val NAME = "TimeflowAlarm"
    private const val NOTIFICATION_REQUEST_CODE = 2401
    private var reactContextRef: WeakReference<ReactApplicationContext>? = null

    @JvmStatic
    fun emitAlarmEvent(type: String, scheduleId: String?, alarmId: String?, title: String?) {
      val context = reactContextRef?.get() ?: return
      if (!context.hasActiveReactInstance()) return
      try {
        val payload = Arguments.createMap()
        payload.putString("type", type)
        payload.putString("scheduleId", scheduleId ?: "")
        payload.putString("alarmId", alarmId ?: "")
        payload.putString("title", title ?: "")
        payload.putDouble("atMillis", System.currentTimeMillis().toDouble())
        context
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_NAME, payload)
      } catch (_: Exception) {
        // 后台响铃时桥接可能已拆除，忽略发送失败。
      }
    }

    const val EVENT_NAME = "TimeflowAlarmEvent"
  }
}

private fun ContextCompatPermissionGranted(context: ReactApplicationContext): Boolean {
  return androidx.core.content.ContextCompat.checkSelfPermission(
    context,
    Manifest.permission.POST_NOTIFICATIONS,
  ) == PackageManager.PERMISSION_GRANTED
}
