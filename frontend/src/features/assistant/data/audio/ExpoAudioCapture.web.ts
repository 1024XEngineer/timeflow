import type { AudioCapturePort } from '../../application/interfaces/AudioCapturePort';

import { concatFloat32, drainPcmChunks, PCM_S16LE_SAMPLE_RATE_HZ, resampleLinear } from './pcm';
import { createBrowserAudioRuntime, type WebAudioRuntime } from './webAudioRuntime';

const PROCESSOR_BUFFER_SIZE = 4096;
const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    autoGainControl: true,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
  },
  video: false,
};

/**
 * Web 不能加载 `@irvingouj/expo-audio-stream`（import 时就会 requireNativeModule）。
 * 用 getUserMedia + ScriptProcessor 采到与原生一致的 16kHz 单声道 pcm_s16le。
 */
export class ExpoAudioCapture implements AudioCapturePort {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private pending = new Float32Array(0);
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;

  constructor(private readonly runtime: WebAudioRuntime = createBrowserAudioRuntime()) {}

  async requestPermission(): Promise<boolean> {
    try {
      const stream = await this.runtime.getUserMedia(MIC_CONSTRAINTS);
      stopTracks(stream);
      return true;
    } catch {
      return false;
    }
  }

  async start(onChunk: (chunk: ArrayBuffer, soundLevel: number | null) => void): Promise<void> {
    await this.stop();
    const stream = await this.runtime.getUserMedia(MIC_CONSTRAINTS);
    const context = this.runtime.createAudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = createScriptProcessor(context);
    const gain = context.createGain();
    gain.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(input, context.sampleRate, PCM_S16LE_SAMPLE_RATE_HZ);
      const drained = drainPcmChunks(concatFloat32(this.pending, resampled));
      this.pending = drained.remaining;
      for (const chunk of drained.chunks) {
        onChunk(chunk.pcm, chunk.soundLevel);
      }
    };
    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);
    this.context = context;
    this.gain = gain;
    this.processor = processor;
    this.source = source;
    this.stream = stream;
  }

  async stop(): Promise<void> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.gain?.disconnect();
    if (this.stream != null) {
      stopTracks(this.stream);
    }
    const context = this.context;
    this.context = null;
    this.gain = null;
    this.pending = new Float32Array(0);
    this.processor = null;
    this.source = null;
    this.stream = null;
    if (context != null && context.state !== 'closed') {
      await context.close();
    }
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function createScriptProcessor(context: AudioContext): ScriptProcessorNode {
  const factory = (
    context as AudioContext & {
      createScriptProcessor?: (
        bufferSize: number,
        inputChannels: number,
        outputChannels: number,
      ) => ScriptProcessorNode;
    }
  ).createScriptProcessor;
  if (typeof factory !== 'function') {
    throw new Error('当前浏览器不支持实时麦克风采集');
  }
  return factory.call(context, PROCESSOR_BUFFER_SIZE, 1, 1);
}
