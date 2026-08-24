package com.timeflow.alarm

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * 全模块共用的单例 TextToSpeech 引擎。真机排查发现：AlarmSoundService 自己
 * new TextToSpeech() 时几乎总是 status=-1（ERROR）失败——这个 Service 在真实场景下
 * 经常是"App 已经在后台/被系统认为受限"的状态下才第一次启动，而 TextToSpeech 内部
 * 是 bindService() 绑定到 TTS 引擎所在的另一个 App，MIUI 之类的 ROM 会拦住后台进程
 * 新发起的这类跨进程绑定——这跟"设备到底装没装 TTS 引擎"是两回事（同一台设备在前台
 * 手动试听是正常的）。
 *
 * 应对办法：改成全局单例，在 AlarmModule 构造时（React Native 加载原生模块的那一刻，
 * 几乎总是应用正常启动、处于前台的时机）就抢先绑定一次，而不是拖到真的要响铃、
 * 前台状态已经不可控的那一刻。只要 App 进程本身还活着（没被系统整个杀掉），后续
 * AlarmSoundService 复用这条已经建立好的连接大概率不受"新绑定被拦"这条限制影响。
 *
 * 局限：App 进程被系统整个杀掉、又被闹钟的 PendingIntent 重新拉起这种冷启动场景，
 * 这个提前绑定帮不上忙——那种情况下这里同样是第一次尝试绑定，跟改之前一样可能被拦。
 * 这只解决"进程还活着、只是被认为在后台"这一种场景，不是万能药。
 */
object AlarmTtsEngine {
    private const val TAG = "AlarmTtsEngine"

    private var engine: TextToSpeech? = null
    @Volatile
    private var ready = false
    private var initStarted = false
    private var pendingReadyCallback: (() -> Unit)? = null

    /** 幂等：只有第一次调用真的会去 new TextToSpeech()，后面全是空操作。 */
    @JvmStatic
    @Synchronized
    fun ensureInitialized(context: Context) {
        if (initStarted) {
            return
        }
        initStarted = true
        val appContext = context.applicationContext
        try {
            engine = TextToSpeech(appContext) { status -> onInit(status) }
        } catch (error: RuntimeException) {
            Log.w(TAG, "TextToSpeech unavailable", error)
            engine = null
            ready = false
        }
    }

    private fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            Log.w(TAG, "init failed status=$status")
            ready = false
            return
        }
        val locale = Locale.getDefault()
        val availability = engine?.isLanguageAvailable(locale) ?: TextToSpeech.LANG_NOT_SUPPORTED
        if (availability == TextToSpeech.LANG_MISSING_DATA ||
            availability == TextToSpeech.LANG_NOT_SUPPORTED
        ) {
            Log.w(TAG, "language unavailable locale=$locale")
            ready = false
            return
        }
        engine?.setLanguage(locale)
        engine?.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        ready = true
        Log.i(TAG, "ready")
        val callback = pendingReadyCallback
        pendingReadyCallback = null
        callback?.invoke()
    }

    @JvmStatic
    fun isReady(): Boolean = ready

    /**
     * 引擎还没就绪时先记下这个回调，onInit 成功那一刻回调一次；已经就绪就立刻同步调用。
     * 只保留最新这一个——同一时间只有一条闹钟在展示（presentAlarm() 本身是互斥的），
     * 不需要支持多个等待者排队。
     */
    @JvmStatic
    fun notifyWhenReady(callback: Runnable) {
        if (ready) {
            callback.run()
            return
        }
        pendingReadyCallback = { callback.run() }
    }

    /** 每次响铃前调用，把这条闹钟自己的 onDone/onError 行为接上；引擎不存在时空操作。 */
    @JvmStatic
    fun setUtteranceListener(listener: UtteranceProgressListener?) {
        engine?.setOnUtteranceProgressListener(listener)
    }

    /** 引擎不存在或还没就绪时返回 TextToSpeech.ERROR，调用方据此决定要不要退回打包铃。 */
    @JvmStatic
    fun speak(text: String, utteranceId: String): Int {
        val current = engine
        if (current == null || !ready) {
            return TextToSpeech.ERROR
        }
        return current.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
    }

    /** 只停当前这句在念的话，不销毁引擎——引擎是全局单例，换下一条闹钟/下次冷启动都要复用。 */
    @JvmStatic
    fun stop() {
        engine?.stop()
    }
}
