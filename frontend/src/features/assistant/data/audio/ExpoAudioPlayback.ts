import { EncodingTypes, ExpoPlayAudioStream } from '@irvingouj/expo-audio-stream';

import type { AssistantAudioPlaybackPort } from '../../application/interfaces/AssistantAudioPlaybackPort';

import { arrayBufferToBase64 } from './base64';

/**
 * TTS 回复的流式播放真实实现：voice.tts.start 开一条流、陆续 pushChunk、
 * voice.tts.end 收尾。同一条流内所有分片用同一个 streamId，播放端靠它保序。
 *
 * 用的是 `@irvingouj/expo-audio-stream`，播放侧 API 跟原始 `@mykin-ai/expo-
 * audio-stream` 一致（这个 fork 只改了采集侧的编译 bug 和录音/流式接口划分）。
 */
export class ExpoAudioPlayback implements AssistantAudioPlaybackPort {
  private streamId: string | null = null;

  async startStream(format: { sampleRateHz: number; encoding: 'pcm_s16le' }): Promise<void> {
    this.streamId = `assistant-tts-${Date.now()}`;
    await ExpoPlayAudioStream.setSoundConfig({
      // 服务端 TTS 是 24000Hz，而包里 SoundConfig.sampleRate 的 TS 类型只列了
      // 16000|44100|48000。这个类型比原生窄：Android 侧是
      // `(config["sampleRate"] as? Number)?.toInt()` 后直接交给 AudioTrack，
      // 任意合法采样率都收。按类型退回 16000 会让 24k 音频慢 1.5 倍播出来，
      // 所以这里原样透传，只在类型上绕过那个过窄的联合类型。
      sampleRate: format.sampleRateHz as 16000 | 44100 | 48000,
    });
  }

  async pushChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.streamId === null) {
      throw new Error('pushChunk called before startStream');
    }
    await ExpoPlayAudioStream.playAudio(
      arrayBufferToBase64(chunk),
      this.streamId,
      EncodingTypes.PCM_S16LE,
    );
  }

  async endStream(): Promise<void> {
    this.streamId = null;
  }

  async stop(): Promise<void> {
    this.streamId = null;
    await ExpoPlayAudioStream.stopAudio();
  }
}
