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
 * 开播前先攒够这么久的音频，再一次性交给原生播放器。
 *
 * 读原生模块的源码（AudioPlaybackManager.playChunk）才看明白卡在哪：它的队列是
 * Channel.UNLIMITED，数据一旦交过去就跟 JS 无关了；但播放循环是「阻塞写一块 → 空等
 * 这块时长的 50% → 再取下一块」，稳态下供给和消费刚好打平，而 AudioTrack 的缓冲
 * （minBufferSize*2）只有几十毫秒。也就是说余量薄到几乎贴着底线，队列一见底就是一个
 * 听得见的空隙。
 *
 * 队列什么时候最薄？每条回复刚开始那几百毫秒——第一帧到了就立刻开播，后面一帧稍微
 * 晚一点就断。往后 vendor 生成快于播放，队列很快攒起来，就再也断不了了。所以要补的
 * 是起跑余量，不是「在 JS 里囤数据防 JS 卡顿」（JS 卡顿在队列有存货时根本不影响）。
 *
 * 代价是首字音频晚这么久。200ms 够盖住一帧的到达抖动，相对整轮 ~2 秒的响应约 10%。
 * 还听得到断音就调大，嫌慢就调小——只有这一个常量。
 */
const PREBUFFER_MS = 200;

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
  /** 起跑余量的门槛，按这条流的采样率算出来的字节数。 */
  private prebufferBytes = 0;
  /** 还没交给播放器、正攒着凑起跑余量的块；攒够或收尾时一次性交出去。 */
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  /** 起跑余量已经交出去了，之后的块直通，不再攒。 */
  private primed = false;

  async startStream(format: { sampleRateHz: number; encoding: 'pcm_s16le' }): Promise<void> {
    this.streamCounter += 1;
    this.streamId = `assistant-tts-${Date.now()}-${this.streamCounter}`;
    // 每块字节数 = 采样率 × 每样本字节数 × 目标时长（秒）。
    this.splitBytes = Math.max(
      1,
      Math.round(format.sampleRateHz * BYTES_PER_SAMPLE * (SPLIT_MS / 1000)),
    );
    this.prebufferBytes = Math.max(
      1,
      Math.round(format.sampleRateHz * BYTES_PER_SAMPLE * (PREBUFFER_MS / 1000)),
    );
    // 每条回复各攒各的：上一条播完之后原生队列就空了，新的一条同样是从零起跑。
    this.discardPending();
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
    if (this.primed) {
      await this.write(streamId, [chunk]);
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes < this.prebufferBytes) {
      return;
    }
    this.primed = true;
    await this.write(streamId, this.takePending());
  }

  async endStream(): Promise<void> {
    const streamId = this.streamId;
    // 「好的。」这种短回复整条都可能不到门槛。收尾时必须把攒着的交出去，否则这句
    // 回复一个字都不会响。
    if (streamId !== null && this.pendingBytes > 0) {
      this.primed = true;
      await this.write(streamId, this.takePending());
    }
    this.streamId = null;
    this.discardPending();
  }

  async stop(): Promise<void> {
    this.streamId = null;
    // 攒着的那段属于被放弃的那条回复，不能留到下一条流开起来再补播出去。
    this.discardPending();
    await ExpoPlayAudioStream.stopAudio();
  }

  /** 把这些块切成小片依次写进播放器，中途这条流被换掉就停手。 */
  private async write(streamId: string, chunks: readonly ArrayBuffer[]): Promise<void> {
    for (const chunk of chunks) {
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
  }

  private takePending(): ArrayBuffer[] {
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    return queued;
  }

  private discardPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.primed = false;
  }
}
