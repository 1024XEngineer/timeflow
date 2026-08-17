import type { AssistantAudioPlaybackPort } from '../../application/interfaces/AssistantAudioPlaybackPort';

/**
 * Web 不能加载 `@irvingouj/expo-audio-stream`。预览不播放 TTS。
 */
export class ExpoAudioPlayback implements AssistantAudioPlaybackPort {
  async startStream(): Promise<void> {}

  async pushChunk(): Promise<void> {}

  async endStream(): Promise<void> {}

  async stop(): Promise<void> {}
}
