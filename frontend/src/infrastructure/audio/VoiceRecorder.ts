import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  type EmitterSubscription,
} from 'react-native';

export type AudioChunkHandler = (chunk: ArrayBuffer) => void;

export type VoiceRecorder = {
  start(onChunk: AudioChunkHandler): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
};

export class VoiceRecordingUnavailableError extends Error {
  constructor(message = '当前构建未提供录音适配器') {
    super(message);
    this.name = 'VoiceRecordingUnavailableError';
  }
}

type BrowserMediaStreamTrack = { stop: () => void };
type BrowserMediaStream = { getTracks: () => BrowserMediaStreamTrack[] };
type BrowserAudioBuffer = {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
};
type BrowserAudioProcessEvent = { inputBuffer: BrowserAudioBuffer };
type BrowserAudioNode = {
  connect: (node: BrowserAudioNode) => void;
  disconnect: () => void;
};
type BrowserScriptProcessor = BrowserAudioNode & {
  onaudioprocess: ((event: BrowserAudioProcessEvent) => void) | null;
};
type BrowserGainNode = BrowserAudioNode & { gain: { value: number } };
type BrowserAudioContext = {
  sampleRate: number;
  destination: BrowserAudioNode;
  state?: string;
  createMediaStreamSource: (stream: BrowserMediaStream) => BrowserAudioNode;
  createScriptProcessor: (
    bufferSize: number,
    inputChannels: number,
    outputChannels: number,
  ) => BrowserScriptProcessor;
  createGain: () => BrowserGainNode;
  resume?: () => Promise<void>;
  close?: () => Promise<void>;
};
type BrowserAudioContextConstructor = new () => BrowserAudioContext;
type BrowserNavigator = {
  mediaDevices?: {
    getUserMedia: (constraints: { audio: boolean }) => Promise<BrowserMediaStream>;
  };
};

function pcm16Chunk(input: BrowserAudioBuffer, targetRate: number): ArrayBuffer | null {
  if (input.length === 0) return null;
  const channels = Array.from({ length: Math.max(1, input.numberOfChannels) }, (_, index) =>
    input.getChannelData(index),
  );
  const ratio = input.sampleRate / targetRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new ArrayBuffer(outputLength * 2);
  const view = new DataView(output);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = Math.min(input.length - 1, Math.floor(index * ratio));
    let sample = 0;
    for (const channel of channels) sample += channel[sourceIndex] ?? 0;
    sample /= channels.length;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return output;
}

/**
 * Browser recorder that emits mono 16 kHz PCM16 frames, matching the voice
 * stream contract. It intentionally does not use MediaRecorder because its
 * WebM/Opus output cannot be labelled as PCM without corrupting the protocol.
 */
export class BrowserPcmVoiceRecorder implements VoiceRecorder {
  private stream: BrowserMediaStream | null = null;
  private context: BrowserAudioContext | null = null;
  private source: BrowserAudioNode | null = null;
  private processor: BrowserScriptProcessor | null = null;
  private gain: BrowserGainNode | null = null;

  async start(onChunk: AudioChunkHandler): Promise<void> {
    if (this.context) {
      throw new Error('录音已经开始');
    }
    const browserNavigator = (globalThis as { navigator?: BrowserNavigator }).navigator;
    const mediaDevices = browserNavigator?.mediaDevices;
    const audioGlobals = globalThis as unknown as {
      AudioContext?: BrowserAudioContextConstructor;
      webkitAudioContext?: BrowserAudioContextConstructor;
    };
    const contextConstructor = audioGlobals.AudioContext;
    const WebkitAudioContext = audioGlobals.webkitAudioContext;
    if (!mediaDevices?.getUserMedia || (!contextConstructor && !WebkitAudioContext)) {
      throw new VoiceRecordingUnavailableError('当前浏览器不支持 PCM 麦克风采集');
    }

    let stream: BrowserMediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      throw new VoiceRecordingUnavailableError(
        `麦克风权限未授予: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const context = new (contextConstructor ?? WebkitAudioContext!)();
    try {
      await context.resume?.();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const gain = context.createGain();
      // Keep the processor in the audio graph without feeding microphone audio
      // back to the speakers.
      gain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        const chunk = pcm16Chunk(event.inputBuffer, 16_000);
        if (chunk) onChunk(chunk);
      };
      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);
      this.stream = stream;
      this.context = context;
      this.source = source;
      this.processor = processor;
      this.gain = gain;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close?.();
      throw new VoiceRecordingUnavailableError(
        `初始化 PCM 录音失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.release();
  }

  async cancel(): Promise<void> {
    await this.release();
  }

  private async release(): Promise<void> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close?.();
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.gain = null;
  }
}

type TimeflowVoiceRecorderNative = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

type NativeRecorderErrorEvent = { message?: string };

const AUDIO_CHUNK_EVENT = 'TimeflowVoiceRecorderChunk';
const ERROR_EVENT = 'TimeflowVoiceRecorderError';

function base64PcmToArrayBuffer(data: string): ArrayBuffer {
  const atob = (globalThis as { atob?: (value: string) => string }).atob;
  if (!atob) throw new VoiceRecordingUnavailableError('当前 JavaScript 引擎不支持音频解码');
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

export class AndroidPcmVoiceRecorder implements VoiceRecorder {
  private readonly nativeRecorder: TimeflowVoiceRecorderNative | undefined;
  private readonly eventEmitter: NativeEventEmitter | null;
  private subscriptions: EmitterSubscription[] = [];
  private recording = false;
  private runtimeError: Error | null = null;

  constructor(
    nativeRecorder:
      TimeflowVoiceRecorderNative | null | undefined = NativeModules.TimeflowVoiceRecorder,
  ) {
    this.nativeRecorder = nativeRecorder ?? undefined;
    this.eventEmitter = nativeRecorder ? new NativeEventEmitter(nativeRecorder) : null;
  }

  async start(onChunk: AudioChunkHandler): Promise<void> {
    if (!this.nativeRecorder || !this.eventEmitter) {
      throw new VoiceRecordingUnavailableError('原生录音模块未链接，请重新安装最新 APK');
    }
    if (this.recording) throw new Error('录音已经开始');

    const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
    const granted =
      (await PermissionsAndroid.check(permission)) ||
      (await PermissionsAndroid.request(permission, {
        title: '麦克风权限',
        message: 'Timeflow 需要使用麦克风，将语音整理成日程。',
        buttonPositive: '允许',
        buttonNegative: '取消',
      })) === PermissionsAndroid.RESULTS.GRANTED;
    if (!granted) {
      throw new VoiceRecordingUnavailableError('麦克风权限未授予');
    }

    this.runtimeError = null;
    this.subscriptions = [
      this.eventEmitter.addListener(AUDIO_CHUNK_EVENT, (data: string) => {
        if (!this.recording) return;
        try {
          onChunk(base64PcmToArrayBuffer(data));
        } catch (error) {
          this.runtimeError = error instanceof Error ? error : new Error(String(error));
        }
      }),
      this.eventEmitter.addListener(ERROR_EVENT, (event: NativeRecorderErrorEvent) => {
        this.runtimeError = new Error(event.message ?? '原生录音失败');
      }),
    ];
    this.recording = true;

    try {
      await this.nativeRecorder.start();
    } catch (error) {
      this.releaseListeners();
      this.recording = false;
      throw new VoiceRecordingUnavailableError(
        `启动原生录音失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.recording) return;
    try {
      await this.nativeRecorder?.stop();
    } finally {
      this.recording = false;
      this.releaseListeners();
    }
    if (this.runtimeError) {
      const error = this.runtimeError;
      this.runtimeError = null;
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.recording) return;
    try {
      await this.nativeRecorder?.cancel();
    } finally {
      this.recording = false;
      this.runtimeError = null;
      this.releaseListeners();
    }
  }

  private releaseListeners(): void {
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
  }
}

/** Fallback for native platforms that do not have a PCM recorder implementation. */
export class UnavailableVoiceRecorder implements VoiceRecorder {
  constructor(private readonly reason = '原生录音模块未链接') {}

  async start(_onChunk: AudioChunkHandler): Promise<void> {
    throw new VoiceRecordingUnavailableError(this.reason);
  }

  async stop(): Promise<void> {
    // No stream was started.
  }

  async cancel(): Promise<void> {
    // No stream was started.
  }
}

export function createVoiceRecorder(): VoiceRecorder {
  if (Platform.OS === 'web') return new BrowserPcmVoiceRecorder();
  if (Platform.OS === 'android') return new AndroidPcmVoiceRecorder();
  return new UnavailableVoiceRecorder('当前平台尚未提供 PCM/流式录音适配器');
}
