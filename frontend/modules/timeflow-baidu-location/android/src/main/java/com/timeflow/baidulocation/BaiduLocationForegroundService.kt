package com.timeflow.baidulocation

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * 地点提醒连续定位所需的 location 类型前台服务。
 * LocationClient 本身不是 FGS；Android 8+/14+ 后台持续定位必须由本进程持有该服务。
 */
class BaiduLocationForegroundService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    createChannel()
    val notification =
      Notification.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setContentTitle("地点提醒运行中")
        .setContentText("正在使用定位以触发地点提醒")
        .setOngoing(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .build()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: RuntimeException) {
      stopSelf()
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "地点提醒", NotificationManager.IMPORTANCE_LOW).apply {
        description = "地点提醒在后台使用定位时显示"
        setShowBadge(false)
      },
    )
  }

  companion object {
    private const val CHANNEL_ID = "timeflow_location"
    private const val NOTIFICATION_ID = 7101

    fun start(context: Context) {
      val intent = Intent(context, BaiduLocationForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, BaiduLocationForegroundService::class.java))
    }
  }
}
