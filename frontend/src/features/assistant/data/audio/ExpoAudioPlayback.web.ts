import type { AssistantAudioPlaybackPort } from '../../application/interfaces/AssistantAudioPlaybackPort';

/** Web 没有原生 TTS 流播放模块；预览和浏览器构建使用此占位实现。 */
export class ExpoAudioPlayback implements AssistantAudioPlaybackPort {
  async startStream(_format: { sampleRateHz: number; encoding: 'pcm_s16le' }): Promise<void> {}

  async pushChunk(_chunk: ArrayBuffer): Promise<void> {}

  async endStream(): Promise<void> {}

  async stop(): Promise<void> {}
}
