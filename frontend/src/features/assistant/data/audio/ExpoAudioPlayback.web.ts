import type { AssistantAudioPlaybackPort } from '../../application/interfaces/AssistantAudioPlaybackPort';

import { pcmS16leToFloat32, resampleLinear } from './pcm';
import { createBrowserAudioRuntime, type WebAudioRuntime } from './webAudioRuntime';

/**
 * 流式 TTS：把服务端 pcm_s16le 分片排进 Web Audio，按到达顺序无缝衔接。
 * 不加载原生 ExpoPlayAudioStream，避免 Web 预览在模块加载阶段崩溃。
 */
export class ExpoAudioPlayback implements AssistantAudioPlaybackPort {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sampleRateHz = 24000;
  private sources: AudioBufferSourceNode[] = [];
  private streamOpen = false;

  constructor(private readonly runtime: WebAudioRuntime = createBrowserAudioRuntime()) {}

  async startStream(format: { sampleRateHz: number; encoding: 'pcm_s16le' }): Promise<void> {
    await this.stop();
    this.sampleRateHz = format.sampleRateHz;
    const context = this.runtime.createAudioContext(format.sampleRateHz);
    await context.resume();
    this.context = context;
    this.nextStartTime = context.currentTime;
    this.streamOpen = true;
  }

  async pushChunk(chunk: ArrayBuffer): Promise<void> {
    const context = this.context;
    if (context == null || !this.streamOpen) {
      throw new Error('pushChunk called before startStream');
    }
    const floats = resampleLinear(pcmS16leToFloat32(chunk), this.sampleRateHz, context.sampleRate);
    if (floats.length === 0) {
      return;
    }
    const buffer = context.createBuffer(1, floats.length, context.sampleRate);
    buffer.copyToChannel(floats, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.push(source);
  }

  async endStream(): Promise<void> {
    this.streamOpen = false;
  }

  async stop(): Promise<void> {
    this.streamOpen = false;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // 已经结束的 BufferSource 再 stop 会抛 InvalidStateError。
      }
    }
    this.sources = [];
    this.nextStartTime = 0;
    const context = this.context;
    this.context = null;
    if (context != null && context.state !== 'closed') {
      await context.close();
    }
  }
}
