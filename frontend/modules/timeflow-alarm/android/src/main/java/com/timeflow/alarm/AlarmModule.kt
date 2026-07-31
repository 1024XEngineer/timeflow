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
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

class AlarmModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  @ReactMethod
  fun schedule(triggerAtMillis: Double, title: String?, promise: Promise) {
    try {
      val alarmId = AlarmScheduler.schedule(
        reactContext,
        triggerAtMillis.toLong(),
        title ?: "日程提醒"
      )
      val result: WritableMap = Arguments.createMap()
      result.putString("alarmId", alarmId)
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
        ContextCompat.checkSelfPermission(
          reactContext,
          Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
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
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NO_ACTIVITY", "Activity unavailable")
      return
    }
    if (ContextCompat.checkSelfPermission(
        reactContext,
        Manifest.permission.POST_NOTIFICATIONS
      ) == PackageManager.PERMISSION_GRANTED
    ) {
      promise.resolve(true)
      return
    }
    ActivityCompat.requestPermissions(
      activity,
      arrayOf(Manifest.permission.POST_NOTIFICATIONS),
      2401
    )
    // Result is delivered asynchronously; caller should re-check getPermissionStatus.
    promise.resolve(false)
  }

  companion object {
    const val NAME = "TimeflowAlarm"
  }
}
