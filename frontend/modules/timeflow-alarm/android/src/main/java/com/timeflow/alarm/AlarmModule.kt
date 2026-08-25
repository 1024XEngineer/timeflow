package com.timeflow.alarm

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

class AlarmModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  init {
    reactContextRef = WeakReference(reactContext)
    // 抢在这一刻（React Native 加载原生模块，几乎总是应用正常启动、前台）就绑定 TTS
    // 引擎，而不是拖到 AlarmSoundService 真的要响铃、前台状态已经不可控的那一刻——
    // 详见 AlarmTtsEngine 顶部注释里追出来的真机故障场景。
    AlarmTtsEngine.ensureInitialized(reactContext)
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
    vibrate: Boolean,
    soundTier: String?,
    fullScreen: Boolean,
    speechText: String?,
    promise: Promise,
  ) {
    try {
      Log.i(
        NAME,
        "schedule triggerAtMillis=$triggerAtMillis title=$title scheduleId=$scheduleId " +
          "vibrate=$vibrate soundTier=$soundTier fullScreen=$fullScreen",
      )
      val alarmId = AlarmScheduler.schedule(
        reactContext,
        triggerAtMillis.toLong(),
        title ?: "日程提醒",
        scheduleId ?: "",
        vibrate,
        soundTier ?: AlarmContract.SOUND_TIER_FULL,
        fullScreen,
        speechText ?: "",
      )
      Log.i(NAME, "scheduled alarmId=$alarmId")
      val result: WritableMap = Arguments.createMap()
      result.putString("alarmId", alarmId)
      result.putString("scheduleId", scheduleId ?: "")
      promise.resolve(result)
    } catch (error: IllegalArgumentException) {
      Log.w(NAME, "schedule rejected: trigger_in_past", error)
      promise.reject("TRIGGER_IN_PAST", error.message, error)
    } catch (error: SecurityException) {
      Log.w(NAME, "schedule rejected: exact_alarm_denied", error)
      promise.reject("EXACT_ALARM_DENIED", error.message, error)
    } catch (error: Exception) {
      Log.w(NAME, "schedule rejected: unexpected", error)
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

  /**
   * 提醒守护后台任务（reminderGuardTask.ts）判断"这条时间型日程原生闹钟当初有没有
   * 挂上"用——JS 内存里的 registrations 在守护任务可能运行的独立/headless 上下文里
   * 拿不到，只有 AlarmScheduler 持久化的挂钟列表是跨上下文都能查的真相来源。
   */
  @ReactMethod
  fun hasArmedAlarm(scheduleId: String?, promise: Promise) {
    try {
      if (scheduleId.isNullOrEmpty()) {
        promise.resolve(false)
        return
      }
      val armed = AlarmScheduler.loadAlarms(reactContext).any { it.scheduleId == scheduleId }
      promise.resolve(armed)
    } catch (error: Exception) {
      promise.reject("HAS_ARMED_ALARM_FAILED", error.message, error)
    }
  }

  /**
   * 之前这里在 AlarmSoundService.start() 一发出去就 resolve(true)——那只代表
   * "启动请求发出了"，startForegroundService() 本身就是即发即弃，压根不等
   * onStartCommand() 真的跑起来。真机上出现过"响一次、其实什么都没展示"却被
   * 当成已展示处理、跳过通知兜底的情况。现在改成真的等 AlarmSoundService 那边
   * 报回来：presentAlarm() 成功 startForeground()（哪怕只是排队顶不上、退化成
   * 一条普通通知）才算 true，startForeground() 本身抛异常（后台启动限制之类）
   * 才是 false。用 alarmId 做 key 把 promise 存起来，AlarmSoundService/
   * AlarmNativeBridge 那边跑到结果已知的地方回调 resolvePresentation()。
   *
   * 有超时兜底：Service 可能被系统直接拒绝调度（Doze/后台限制），永远等不到
   * onStartCommand() 真的执行，不能让这个 promise 挂死——JS 那边的
   * presentOrNotify() 还指着这个结果决定要不要发兜底通知。
   */
  @ReactMethod
  fun presentNow(
    alarmId: String?,
    scheduleId: String?,
    title: String?,
    vibrate: Boolean,
    soundTier: String?,
    fullScreen: Boolean,
    speechText: String?,
    promise: Promise,
  ) {
    val resolvedAlarmId = alarmId?.takeIf { it.isNotEmpty() } ?: "geofence-${System.currentTimeMillis()}"
    try {
      val resolvedScheduleId = scheduleId ?: ""
      val resolvedTitle = title?.takeIf { it.isNotEmpty() } ?: "日程提醒"
      pendingPresentations[resolvedAlarmId] = promise
      mainHandler.postDelayed(
        {
          pendingPresentations.remove(resolvedAlarmId)?.resolve(false)
        },
        PRESENT_TIMEOUT_MILLIS,
      )
      AlarmSoundService.start(
        reactContext,
        resolvedAlarmId,
        resolvedScheduleId,
        AlarmScheduler.immediateRequestCode(resolvedAlarmId),
        resolvedTitle,
        vibrate,
        soundTier ?: AlarmContract.SOUND_TIER_FULL,
        fullScreen,
        speechText ?: "",
      )
      Log.i(NAME, "presentNow requested alarmId=$resolvedAlarmId scheduleId=$resolvedScheduleId")
    } catch (error: Exception) {
      Log.w(NAME, "presentNow failed", error)
      pendingPresentations.remove(resolvedAlarmId)
      promise.reject("PRESENT_NOW_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun peekNativeDispositions(promise: Promise) {
    try {
      val records = AlarmNativeBridge.peekDispositions(reactContext)
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
      promise.reject("PEEK_DISPOSITIONS_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun ackNativeDispositions(scheduleIds: ReadableArray, promise: Promise) {
    try {
      val acked = HashSet<String>()
      for (index in 0 until scheduleIds.size()) {
        scheduleIds.getString(index)?.let { acked.add(it) }
      }
      AlarmNativeBridge.ackDispositions(reactContext, acked)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("ACK_DISPOSITIONS_FAILED", error.message, error)
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

      val manufacturer = OemPermissionHelper.detectManufacturer()
      status.putString("manufacturer", manufacturer)
      status.putBoolean(
        "oemAutostartGuided",
        OemPermissionHelper.isGuided(reactContext, OemPermissionHelper.KIND_AUTOSTART),
      )
      status.putBoolean(
        "oemBackgroundPopupGuided",
        OemPermissionHelper.isGuided(reactContext, OemPermissionHelper.KIND_BACKGROUND_POPUP),
      )
      status.putBoolean(
        "oemLastOverlayFailed",
        OemPermissionHelper.wasLastOverlayFailure(reactContext),
      )

      promise.resolve(status)
    } catch (error: Exception) {
      promise.reject("PERMISSION_STATUS_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun openPermissionSettings(kind: String?, promise: Promise) {
    if (kind == OemPermissionHelper.KIND_AUTOSTART || kind == OemPermissionHelper.KIND_BACKGROUND_POPUP) {
      openOemSettings(kind, promise)
      return
    }
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

  /**
   * 自启动/后台弹出界面没有标准 Settings.ACTION_*，组件名是社区经验值，覆盖不到的
   * 机型/版本（Intent 拼不出来，或 startActivity 解析不到）一律退回应用详情页——
   * 但两种情况都算"带用户去看过了"，照样 markGuided，不是真的成功/失败信号。
   */
  private fun openOemSettings(kind: String, promise: Promise) {
    try {
      val pkg = Uri.parse("package:${reactContext.packageName}")
      val fallbackIntent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val manufacturer = OemPermissionHelper.detectManufacturer()
      val oemIntent = OemPermissionHelper.buildOemSettingsIntent(reactContext, manufacturer, kind)
      if (oemIntent != null) {
        oemIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          reactContext.startActivity(oemIntent)
          OemPermissionHelper.markGuided(reactContext, kind)
          promise.resolve(true)
          return
        } catch (error: Exception) {
          Log.w(NAME, "OEM settings intent failed for kind=$kind manufacturer=$manufacturer, falling back", error)
        }
      }
      reactContext.startActivity(fallbackIntent)
      OemPermissionHelper.markGuided(reactContext, kind)
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

    /** presentNow() 等 AlarmSoundService 回报展示结果用的登记表，key 是 alarmId。
     * ConcurrentHashMap.remove() 是原子的，超时回调和 AlarmSoundService 的真实回报
     * 谁先到都只会有一次 resolve()——一个 Promise 被 resolve 两次在 RN 桥上是错误。 */
    private val pendingPresentations = ConcurrentHashMap<String, Promise>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private const val PRESENT_TIMEOUT_MILLIS = 4_000L

    /** AlarmSoundService（Java，同包）在 presentAlarm() 成功/失败之后回调；
     * 没有对应 alarmId 在等（比如原生闹钟自己触发的、不是 presentNow() 发起的）
     * 就是个空操作，不用调用方判断"这次是不是 presentNow 发起的"。 */
    @JvmStatic
    fun resolvePresentation(alarmId: String?, presented: Boolean) {
      if (alarmId.isNullOrEmpty()) return
      pendingPresentations.remove(alarmId)?.resolve(presented)
    }

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
