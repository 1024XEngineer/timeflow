import type { AudioCapturePort } from '../../application/interfaces/AudioCapturePort';

/**
 * Web 不能加载 `@irvingouj/expo-audio-stream`（import 时就会 requireNativeModule）。
 * 预览仍显示语音入口，采集在这里直接不可用。
 */
export class ExpoAudioCapture implements AudioCapturePort {
  async requestPermission(): Promise<boolean> {
    return false;
  }

  async start(): Promise<void> {
    throw new Error('麦克风在 Web 预览中不可用');
  }

  async stop(): Promise<void> {}
}
