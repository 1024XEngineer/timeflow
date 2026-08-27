import { EncodingTypes, ExpoPlayAudioStream } from '@irvingouj/expo-audio-stream';

import type { AssistantAudioPlaybackPort } from '../../application/interfaces/AssistantAudioPlaybackPort';

import { arrayBufferToBase64 } from './base64';
import { splitPcm } from './split-pcm';

/** pcm_s16le 单声道：每样本 2 字节。 */
const BYTES_PER_SAMPLE = 2;

/**
 * 每个原生写入块的时长：把一句 ~400ms 的帧切成约这么长的小块再喂给播放器。
 * 块长存在一个「甜点区」，两头都会卡顿：
 *  - 太大：原生播放循环写完一块会空等这块时长的 50%，这个 50% 一旦超过 AudioTrack
 *    的流式缓冲（minBufferSize*2，几十 ms），缓冲就在句尾被抽干，留出静音空隙。
 *  - 太小：每块固定的 base64/桥接/解码/协程开销不变，块越碎开销占比越大，JS 每块
 *    还要赶一次交付 deadline，抖动被放大成偶发欠载（40ms 实测比不切更卡）。
 * 100ms（24000Hz 下 4800 字节/块）实测是两边的安全交集：50% 延迟 50ms 远小于缓冲，
 * 每句 ~4 块，开销可忽略。
 */
const SPLIT_MS = 100;

/**
 * TTS 回复的流式播放真实实现：voice.tts.start 开一条流、陆续 pushChunk、
 * voice.tts.end 收尾。同一条流内所有分片用同一个 streamId，播放端靠它保序。
 *
 * 用的是 `@irvingouj/expo-audio-stream`，播放侧 API 跟原始 `@mykin-ai/expo-
 * audio-stream` 一致（这个 fork 只改了采集侧的编译 bug 和录音/流式接口划分）。
 *
 * 切分：vendor 吐的是句级大帧（~400ms），原生播放器每写完一帧空等 50% 帧时长，
 * 会把小缓冲抽干、在句间留出静音空隙。这里先把大帧切成 ~100ms 小块再喂，让 50%
 * 延迟缩短到 ~50ms、缓冲不再抽干；同时块也不至于碎到让每块桥接开销压过音频本身。
 */
export class ExpoAudioPlayback implements AssistantAudioPlaybackPort {
  private streamId: string | null = null;
  private splitBytes = 0;
  /** 光靠 Date.now() 不够：两条回复前后脚开流会拿到同一个毫秒、同一个 id，
   * pushChunk 里"这条流还是不是当前那条"的判断就形同虚设，原生播放器也没法
   * 靠 id 把两条流分开。 */
  private streamCounter = 0;

  async startStream(format: { sampleRateHz: number; encoding: 'pcm_s16le' }): Promise<void> {
    this.streamCounter += 1;
    this.streamId = `assistant-tts-${Date.now()}-${this.streamCounter}`;
    // 每块字节数 = 采样率 × 每样本字节数 × 目标时长（秒）。
    this.splitBytes = Math.max(
      1,
      Math.round(format.sampleRateHz * BYTES_PER_SAMPLE * (SPLIT_MS / 1000)),
    );
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
    const streamId = this.streamId;
    if (streamId === null || this.splitBytes <= 0) {
      throw new Error('pushChunk called before startStream');
    }
    for (const piece of splitPcm(chunk, this.splitBytes)) {
      // 每片之前都重新确认这条流还是不是当前那条：上一片还卡在原生桥上的时候，
      // stop()（打断）或下一条回复的 startStream() 可能已经把它换掉了。不确认的话
      // 剩下的片会在 stopAudio() 之后继续写进播放器，把刚被打断那句的尾巴放出来；
      // 而且那时 this.streamId 已经是 null，等于用一条野生的流去播。
      if (this.streamId !== streamId) {
        return;
      }
      await ExpoPlayAudioStream.playAudio(
        arrayBufferToBase64(piece),
        streamId,
        EncodingTypes.PCM_S16LE,
      );
    }
  }

  async endStream(): Promise<void> {
    this.streamId = null;
  }

  async stop(): Promise<void> {
    this.streamId = null;
    await ExpoPlayAudioStream.stopAudio();
  }
}
