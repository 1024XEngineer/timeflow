import type { AudioCapturePort } from '../../application/interfaces/AudioCapturePort';

/** Web 没有原生麦克风流模块；预览和浏览器构建使用此占位实现。 */
export class ExpoAudioCapture implements AudioCapturePort {
  async requestPermission(): Promise<boolean> {
    return false;
  }

  async start(_onChunk: (chunk: ArrayBuffer, soundLevel: number | null) => void): Promise<void> {
    throw new Error('Audio capture is not available on web');
  }

  async stop(): Promise<void> {}
}
