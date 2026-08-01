package com.timeflow.voicerecorder

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.concurrent.thread
import kotlin.math.max

class VoiceRecorderModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val stateLock = Any()

  @Volatile
  private var recording = false
  private var audioRecord: AudioRecord? = null
  private var recordingThread: Thread? = null

  override fun getName(): String = NAME

  @ReactMethod
  fun start(promise: Promise) {
    if (ContextCompat.checkSelfPermission(
        reactContext,
        Manifest.permission.RECORD_AUDIO
      ) != PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("MICROPHONE_PERMISSION_DENIED", "Microphone permission is not granted")
      return
    }

    synchronized(stateLock) {
      if (recording || audioRecord != null) {
        promise.reject("ALREADY_RECORDING", "Voice recording is already active")
        return
      }

      val minimumBufferSize = AudioRecord.getMinBufferSize(
        SAMPLE_RATE_HZ,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
      if (minimumBufferSize <= 0) {
        promise.reject("AUDIO_CONFIG_UNSUPPORTED", "16 kHz mono PCM recording is unsupported")
        return
      }

      val recorder = try {
        AudioRecord(
          MediaRecorder.AudioSource.MIC,
          SAMPLE_RATE_HZ,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          max(minimumBufferSize, CHUNK_BYTES * 2)
        )
      } catch (error: Exception) {
        promise.reject("RECORDER_INIT_FAILED", error.message, error)
        return
      }

      if (recorder.state != AudioRecord.STATE_INITIALIZED) {
        recorder.release()
        promise.reject("RECORDER_INIT_FAILED", "AudioRecord initialization failed")
        return
      }

      try {
        recorder.startRecording()
      } catch (error: Exception) {
        recorder.release()
        promise.reject("RECORDER_START_FAILED", error.message, error)
        return
      }

      audioRecord = recorder
      recording = true
      recordingThread = thread(name = "TimeflowVoiceRecorder") {
        captureAudio(recorder)
      }
    }

    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    stopInternal()
    promise.resolve(null)
  }

  @ReactMethod
  fun cancel(promise: Promise) {
    stopInternal()
    promise.resolve(null)
  }

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by NativeEventEmitter. Android event delivery needs no setup.
  }

  @ReactMethod
  fun removeListeners(count: Double) {
    // Required by NativeEventEmitter. Android event delivery needs no teardown.
  }

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }

  private fun captureAudio(recorder: AudioRecord) {
    val buffer = ByteArray(CHUNK_BYTES)
    try {
      while (recording && audioRecord === recorder) {
        val bytesRead = recorder.read(buffer, 0, buffer.size)
        when {
          bytesRead > 0 -> {
            val data = Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP)
            emit(AUDIO_CHUNK_EVENT, data)
          }
          bytesRead == AudioRecord.ERROR_INVALID_OPERATION ||
            bytesRead == AudioRecord.ERROR_BAD_VALUE ||
            bytesRead == AudioRecord.ERROR_DEAD_OBJECT -> {
            emitError("AudioRecord read failed with code $bytesRead")
            break
          }
        }
      }
    } catch (error: Exception) {
      if (recording) emitError(error.message ?: "Voice recording failed")
    } finally {
      finishRecorder(recorder)
    }
  }

  private fun stopInternal() {
    val recorder: AudioRecord?
    val worker: Thread?
    synchronized(stateLock) {
      recording = false
      recorder = audioRecord
      worker = recordingThread
    }

    try {
      if (recorder?.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
    } catch (_: Exception) {
      // The capture thread may already have stopped and released the recorder.
    }

    if (worker != null && worker !== Thread.currentThread()) {
      try {
        worker.join(STOP_TIMEOUT_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    if (recorder != null) finishRecorder(recorder)
  }

  private fun finishRecorder(recorder: AudioRecord) {
    val shouldRelease = synchronized(stateLock) {
      if (audioRecord !== recorder) {
        false
      } else {
        recording = false
        audioRecord = null
        if (recordingThread === Thread.currentThread()) recordingThread = null
        true
      }
    }
    if (!shouldRelease) return

    try {
      if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
    } catch (_: Exception) {
      // Recorder is already stopped.
    }
    recorder.release()
  }

  private fun emit(eventName: String, value: Any) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(eventName, value)
  }

  private fun emitError(message: String) {
    val payload = Arguments.createMap()
    payload.putString("message", message)
    emit(ERROR_EVENT, payload)
  }

  companion object {
    const val NAME = "TimeflowVoiceRecorder"
    const val AUDIO_CHUNK_EVENT = "TimeflowVoiceRecorderChunk"
    const val ERROR_EVENT = "TimeflowVoiceRecorderError"
    const val SAMPLE_RATE_HZ = 16_000
    const val CHUNK_BYTES = 3_200
    const val STOP_TIMEOUT_MS = 1_500L
  }
}
