import { ExpoPlayAudioStream } from '@irvingouj/expo-audio-stream';
import { PermissionsAndroid, Platform } from 'react-native';

import type { AudioCapturePort } from '../../application/interfaces/AudioCapturePort';

import { base64ToArrayBuffer } from './base64';

/** 协议要求 16kHz 单声道 pcm_s16le；interval 越小，delay 越低、事件越密。 */
const SAMPLE_RATE_HZ = 16000;
const CHANNELS = 1;
const CHUNK_INTERVAL_MS = 100;

/**
 * 麦克风采集的真实实现，边录边把分片转发出去。
 *
 * 用的是 `@irvingouj/expo-audio-stream`（`@mykin-ai/expo-audio-stream` 的 fork），
 * 原包在当前 RN 0.86 / Expo SDK 57 上有三处真实的源码级编译 bug（iOS 缺
 * import、Android JVM target 未设置、Android Promise.reject 签名跟当前
 * expo-modules-core 对不上），这个 fork 修了 Android 那两处，JVM target 那处额外
 * 靠 android/build.gradle 的项目级补丁兜底（见 app 侧 build.gradle 注释）。
 * 只覆盖 Android：项目当前只做安卓机，没有再验证 iOS 那处 import 修没修。
 *
 * 这个 fork 把原来的 startRecording 拆成了 startRecording（录到文件，只有音量
 * 事件）和 startMicrophone（真正的实时 PCM 流），我们要的是后者。
 */
export class ExpoAudioCapture implements AudioCapturePort {
  private subscription: { remove: () => void } | null = null;

  async requestPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      return false;
    }
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  async start(onChunk: (chunk: ArrayBuffer, soundLevel: number | null) => void): Promise<void> {
    const { subscription } = await ExpoPlayAudioStream.startMicrophone({
      channels: CHANNELS,
      encoding: 'pcm_16bit',
      interval: CHUNK_INTERVAL_MS,
      onAudioStream: async (event) => {
        if (event.type === 'microphone' && typeof event.data === 'string') {
          onChunk(base64ToArrayBuffer(event.data), event.soundLevel ?? null);
        }
      },
      sampleRate: SAMPLE_RATE_HZ,
    });
    this.subscription = subscription ?? null;
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    await ExpoPlayAudioStream.stopMicrophone();
  }
}
